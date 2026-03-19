/*
 * kronhal_edatec.h  --  Edatec IPC family HAL implementation
 *
 * Targets:
 *   ED-IPC2xxx series  (Raspberry Pi CM4, BCM2711)
 *   ED-IPC3020         (Raspberry Pi 5,   BCM2712)
 *   ED-IPC3xxx series  (Raspberry Pi CM5, BCM2712)
 *
 * DI / DO architecture:
 *   CM4  ──I2C──►  PCA9535 (GPIO expander, 0x27)  ──►  PhotoCoupler  ──►  DI/DO terminals
 *
 *   PCA9535 is a 16-bit I2C I/O expander:
 *     Port 0  (pins IO0_0 .. IO0_7)  →  DI 0~7  (inputs,  optocoupler active-low → polarity inverted)
 *     Port 1  (pins IO1_0 .. IO1_7)  →  DO 0~7  (outputs, relay/LED)
 *
 *   Default I2C bus  : /dev/i2c-1  (-DKRON_DIO_I2C_BUS=1)
 *   Default I2C addr : 0x27        (-DKRON_PCA9535_ADDR=0x27)
 *
 * GPIO_Read  → reads DI via PCA9535 PORT 0 (polarity already inverted in HW)
 * GPIO_Write → writes DO via PCA9535 PORT 1 (cached read-modify-write)
 * GPIO_SetMode_Call → unsupported on this board (ERR_ID=1), directions fixed at init
 *
 * Compile-time overrides:
 *   -DKRON_DIO_I2C_BUS=1          I2C bus number  (default 1 → /dev/i2c-1)
 *   -DKRON_PCA9535_ADDR=0x27      PCA9535 I2C address
 *   -DKRON_DI_COUNT=8             number of DI channels (0–7 valid)
 *   -DKRON_DO_COUNT=8             number of DO channels (0–7 valid)
 *
 * ERR_ID codes:
 *   0  OK
 *   1  Invalid / unsupported pin (pin >= KRON_DI_COUNT or KRON_DO_COUNT, or SetMode)
 *   2  I2C device open / init failed
 *   3  I2C read/write error
 */
#ifndef KRONHAL_EDATEC_H
#define KRONHAL_EDATEC_H

#include <linux/i2c-dev.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <termios.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

/* ─── Compile-time configuration ─────────────────────────────────────────── */

#ifndef KRON_DIO_I2C_BUS
#define KRON_DIO_I2C_BUS    1
#endif

#ifndef KRON_PCA9535_ADDR
#define KRON_PCA9535_ADDR   0x27
#endif

#ifndef KRON_DI_COUNT
#define KRON_DI_COUNT       8
#endif

#ifndef KRON_DO_COUNT
#define KRON_DO_COUNT       8
#endif

/* ─── PCA9535 register map ───────────────────────────────────────────────── */

#define PCA9535_REG_INPUT_0   0x00   /* Read:  input  state port 0 (DI 0~7)          */
#define PCA9535_REG_INPUT_1   0x01   /* Read:  input  state port 1                    */
#define PCA9535_REG_OUTPUT_0  0x02   /* Write: output state port 0                    */
#define PCA9535_REG_OUTPUT_1  0x03   /* Write: output state port 1 (DO 0~7)           */
#define PCA9535_REG_POL_0     0x04   /* Polarity inversion port 0: 1=invert           */
#define PCA9535_REG_POL_1     0x05   /* Polarity inversion port 1                     */
#define PCA9535_REG_CFG_0     0x06   /* Config port 0: 1=input,  0=output             */
#define PCA9535_REG_CFG_1     0x07   /* Config port 1: 1=input,  0=output             */

/* ─── Internal limits ────────────────────────────────────────────────────── */

#define _EDATEC_UART_MAX  6
#define _EDATEC_CAN_MAX   2

/* ─── Module-level state ─────────────────────────────────────────────────── */

/* PCA9535 */
static int     _pca_fd      = -1;    /* I2C fd for PCA9535          */
static int     _pca_init    = 0;     /* initialised flag            */
static uint8_t _do_cache    = 0x00;  /* cached DO output state (port 1) */

/* UART */
static int _uart_fd[_EDATEC_UART_MAX];

/* CAN */
static int _can_fd[_EDATEC_CAN_MAX];

/* ─── Lifecycle ──────────────────────────────────────────────────────────── */

static inline void HAL_Init(void) {
    for (int i = 0; i < _EDATEC_UART_MAX; i++) { _uart_fd[i] = -1; }
    for (int i = 0; i < _EDATEC_CAN_MAX;  i++) { _can_fd[i]  = -1; }
}

static inline void HAL_Cleanup(void) {
    /* UART */
    for (int i = 0; i < _EDATEC_UART_MAX; i++) {
        if (_uart_fd[i] >= 0) { close(_uart_fd[i]); _uart_fd[i] = -1; }
    }
    /* CAN */
    for (int i = 0; i < _EDATEC_CAN_MAX; i++) {
        if (_can_fd[i] >= 0) { close(_can_fd[i]); _can_fd[i] = -1; }
    }
    /* PCA9535 */
    if (_pca_fd >= 0) { close(_pca_fd); _pca_fd = -1; }
    _pca_init = 0;
}

/* ─── PCA9535 helpers ────────────────────────────────────────────────────── */

static inline int _pca_write_reg(uint8_t reg, uint8_t val) {
    uint8_t buf[2] = { reg, val };
    return (write(_pca_fd, buf, 2) == 2) ? 0 : -1;
}

static inline int _pca_read_reg(uint8_t reg, uint8_t *out) {
    if (write(_pca_fd, &reg, 1) != 1) return -1;
    return (read(_pca_fd, out, 1) == 1) ? 0 : -1;
}

/*
 * Open PCA9535 on /dev/i2c-{KRON_DIO_I2C_BUS} at address KRON_PCA9535_ADDR.
 *   Port 0 = DI: all inputs,  polarity inverted (optocouplers are active-low)
 *   Port 1 = DO: all outputs, driven low on init
 */
static inline int _pca_init_chip(void) {
    if (_pca_init) return 0;

    char i2c_path[32];
    snprintf(i2c_path, sizeof(i2c_path), "/dev/i2c-%d", KRON_DIO_I2C_BUS);

    _pca_fd = open(i2c_path, O_RDWR);
    if (_pca_fd < 0) return -1;

    if (ioctl(_pca_fd, I2C_SLAVE, KRON_PCA9535_ADDR) < 0) {
        close(_pca_fd); _pca_fd = -1; return -1;
    }

    /* Configure directions */
    if (_pca_write_reg(PCA9535_REG_CFG_0, 0xFF) < 0) goto fail;  /* port 0: all inputs  */
    if (_pca_write_reg(PCA9535_REG_CFG_1, 0x00) < 0) goto fail;  /* port 1: all outputs */

    /* Polarity inversion on port 0: optocouplers are active-low,
     * so 24V present → pin LOW → invert → read returns 1 (true) */
    if (_pca_write_reg(PCA9535_REG_POL_0, 0xFF) < 0) goto fail;

    /* Drive all outputs low on startup */
    _do_cache = 0x00;
    if (_pca_write_reg(PCA9535_REG_OUTPUT_1, 0x00) < 0) goto fail;

    _pca_init = 1;
    return 0;

fail:
    close(_pca_fd); _pca_fd = -1; return -1;
}

/* ─── GPIO Write  (DO via PCA9535 PORT 1) ───────────────────────────────── */

static inline void GPIO_Write_Call(GPIO_Write *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int pin = (int)inst->PIN;
    if (pin < 0 || pin >= KRON_DO_COUNT) { inst->ERR_ID = 1; return; }

    if (_pca_init_chip() < 0) { inst->ERR_ID = 2; return; }

    if (inst->VALUE)
        _do_cache |=  (uint8_t)(1u << pin);
    else
        _do_cache &= ~(uint8_t)(1u << pin);

    if (_pca_write_reg(PCA9535_REG_OUTPUT_1, _do_cache) < 0) {
        inst->ERR_ID = 3; return;
    }
    inst->OK = true;
}

/* ─── GPIO Read  (DI via PCA9535 PORT 0, polarity already inverted) ─────── */

static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int pin = (int)inst->PIN;
    if (pin < 0 || pin >= KRON_DI_COUNT) { inst->ERR_ID = 1; return; }

    if (_pca_init_chip() < 0) { inst->ERR_ID = 2; return; }

    uint8_t port_val = 0;
    if (_pca_read_reg(PCA9535_REG_INPUT_0, &port_val) < 0) {
        inst->ERR_ID = 3; return;
    }
    inst->VALUE = (bool)((port_val >> pin) & 0x01);
}

/* ─── GPIO SetMode  (unsupported: port directions are fixed at init) ─────── */

static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 1;   /* unsupported on this board */
}

/* ─── PWM  (not available via PCA9535) ──────────────────────────────────── */

static inline void HAL_PWM_Call(HAL_PWM *inst, int ch) {
    (void)ch;
    inst->ENO    = inst->EN;
    inst->ACTIVE = false;
    inst->ERR_ID = 1;
}

/* ─── SPI  (TODO) ────────────────────────────────────────────────────────── */

static inline void HAL_SPI_Call(HAL_SPI *inst, int ch) {
    (void)ch;
    inst->ENO     = inst->EN;
    inst->RX_DATA = 0;
    inst->DONE    = false;
    inst->ERR_ID  = 1;
}

/* ─── I2C  (TODO) ────────────────────────────────────────────────────────── */

static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, int ch) {
    (void)ch;
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->OK     = false;
    inst->ERR_ID = 1;
}

static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, int ch) {
    (void)ch;
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 1;
}

/* ─── UART  (RS232 / RS485 ports via /dev/ttyS*) ────────────────────────── */

static const char *_uart_dev[] = {
    "/dev/ttyS0", "/dev/ttyS1", "/dev/ttyS2",
    "/dev/ttyS3", "/dev/ttyS4", "/dev/ttyS5",
};

static inline int _uart_open(int ch, int baud) {
    if (ch < 0 || ch >= _EDATEC_UART_MAX) return -1;
    if (_uart_fd[ch] >= 0) return _uart_fd[ch];

    int fd = open(_uart_dev[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    tcgetattr(fd, &tty);

    speed_t speed = B9600;
    if      (baud >= 921600) speed = B921600;
    else if (baud >= 460800) speed = B460800;
    else if (baud >= 115200) speed = B115200;
    else if (baud >= 57600)  speed = B57600;
    else if (baud >= 38400)  speed = B38400;
    else if (baud >= 19200)  speed = B19200;

    cfsetispeed(&tty, speed);
    cfsetospeed(&tty, speed);
    tty.c_cflag  = (tty.c_cflag & ~CSIZE) | CS8;
    tty.c_cflag |= (CLOCAL | CREAD);
    tty.c_cflag &= ~(PARENB | CSTOPB | CRTSCTS);
    tty.c_iflag = tty.c_oflag = tty.c_lflag = 0;
    tty.c_cc[VMIN] = 0; tty.c_cc[VTIME] = 1;
    tcsetattr(fd, TCSANOW, &tty);

    _uart_fd[ch] = fd;
    return fd;
}

static inline void HAL_UART_Send_Call(HAL_UART_Send *inst, int ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _uart_open(ch, (int)inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = (uint8_t)inst->DATA;
    if (write(fd, &byte, 1) == 1)
        inst->DONE = true;
    else
        inst->ERR_ID = 3;
}

static inline void HAL_UART_Receive_Call(HAL_UART_Receive *inst, int ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _uart_open(ch, (int)inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = 0;
    if (read(fd, &byte, 1) == 1) { inst->DATA = byte; inst->READY = true; }
}

/* ─── ADC  (not present on Edatec IPC) ──────────────────────────────────── */

static inline void HAL_ADC_Read_Call(HAL_ADC_Read *inst, int ch) {
    (void)ch;
    inst->ENO     = inst->EN;
    inst->VALUE   = 0;
    inst->VOLTAGE = 0.0f;
    inst->ERR_ID  = 1;
}

/* ─── CAN  (SocketCAN) ───────────────────────────────────────────────────── */

static const char *_can_iface[] = { "can0", "can1" };

static inline int _can_open(int ch) {
    if (ch < 0 || ch >= _EDATEC_CAN_MAX) return -1;
    if (_can_fd[ch] >= 0) return _can_fd[ch];
    int fd = socket(PF_CAN, SOCK_RAW, CAN_RAW);
    if (fd < 0) return -1;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, _can_iface[ch], IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFINDEX, &ifr) < 0) { close(fd); return -1; }
    struct sockaddr_can addr;
    memset(&addr, 0, sizeof(addr));
    addr.can_family  = AF_CAN;
    addr.can_ifindex = ifr.ifr_ifindex;
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { close(fd); return -1; }
    _can_fd[ch] = fd;
    return fd;
}

static inline void HAL_CAN_Send_Call(HAL_CAN_Send *inst, int ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _can_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    struct can_frame frame;
    memset(&frame, 0, sizeof(frame));
    frame.can_id  = (canid_t)inst->ID;
    frame.can_dlc = (uint8_t)(inst->DLC > 8 ? 8 : inst->DLC);
    frame.data[0] = (uint8_t)inst->DATA;
    if (write(fd, &frame, sizeof(frame)) == (ssize_t)sizeof(frame))
        inst->DONE = true;
    else
        inst->ERR_ID = 3;
}

static inline void HAL_CAN_Receive_Call(HAL_CAN_Receive *inst, int ch) {
    inst->ENO    = inst->EN;
    inst->ID     = 0;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _can_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    struct can_frame frame;
    memset(&frame, 0, sizeof(frame));
    if (read(fd, &frame, sizeof(frame)) == (ssize_t)sizeof(frame)) {
        inst->ID    = (int32_t)frame.can_id;
        inst->DATA  = (uint8_t)frame.data[0];
        inst->READY = true;
    }
}

/* ─── PRU  (not available on CM4/CM5/Pi5) ───────────────────────────────── */

static inline void HAL_PRU_Execute_Call(HAL_PRU_Execute *inst, int ch) {
    (void)ch;
    inst->ENO    = inst->EN;
    inst->RESULT = 0;
    inst->DONE   = false;
    inst->ERR_ID = 1;
}

/* ─── PCM  (TODO: ALSA) ──────────────────────────────────────────────────── */

static inline void PCM_Output_Call(PCM_Output *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 1;
}
static inline void PCM_Input_Call(PCM_Input *inst) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 1;
}

/* ─── Grove  (not present on Edatec IPC) ────────────────────────────────── */

static inline void Grove_DigitalRead_Call(Grove_DigitalRead *inst) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 1;
}
static inline void Grove_DigitalWrite_Call(Grove_DigitalWrite *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 1;
}
static inline void Grove_AnalogRead_Call(Grove_AnalogRead *inst) {
    inst->ENO     = inst->EN;
    inst->VALUE   = 0;
    inst->VOLTAGE = 0.0f;
    inst->ERR_ID  = 1;
}

/* ─── DI  (Isolated Digital Input via PCA9535 PORT 0) ───────────────────── */

static inline void HAL_DI_Read_Call(HAL_DI_Read *inst, int ch) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    if (ch < 0 || ch >= KRON_DI_COUNT) { inst->ERR_ID = 1; return; }

    if (_pca_init_chip() < 0) { inst->ERR_ID = 2; return; }

    uint8_t port_val = 0;
    if (_pca_read_reg(PCA9535_REG_INPUT_0, &port_val) < 0) {
        inst->ERR_ID = 3; return;
    }
    inst->VALUE = (bool)((port_val >> ch) & 0x01);
}

/* ─── DO  (Isolated Digital Output via PCA9535 PORT 1) ──────────────────── */

static inline void HAL_DO_Write_Call(HAL_DO_Write *inst, int ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    if (ch < 0 || ch >= KRON_DO_COUNT) { inst->ERR_ID = 1; return; }

    if (_pca_init_chip() < 0) { inst->ERR_ID = 2; return; }

    if (inst->VALUE)
        _do_cache |=  (uint8_t)(1u << ch);
    else
        _do_cache &= ~(uint8_t)(1u << ch);

    if (_pca_write_reg(PCA9535_REG_OUTPUT_1, _do_cache) < 0) {
        inst->ERR_ID = 3; return;
    }
    inst->OK = true;
}

#endif /* KRONHAL_EDATEC_H */
