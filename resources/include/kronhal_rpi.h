/*
 * kronhal_rpi.h  --  Raspberry Pi family HAL implementation
 *
 * Targets: rpi_3b, rpi_3b_plus, rpi_4b, rpi_5, rpi_zero_2w
 * GPIO: Linux GPIO character device ioctl (linux/gpio.h — no external library)
 *
 * RPi 3B/3B+/4B/Zero2W → /dev/gpiochip0
 * RPi 5                 → /dev/gpiochip4  (set via -DKRON_GPIO_CHIP="/dev/gpiochip4")
 */
#ifndef KRONHAL_RPI_H
#define KRONHAL_RPI_H

#include <linux/gpio.h>
#include <linux/i2c-dev.h>
#include <linux/spi/spidev.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <termios.h>
#include <errno.h>

#ifndef KRON_GPIO_CHIP
#define KRON_GPIO_CHIP "/dev/gpiochip0"
#endif

#define _RPi_GPIO_MAX 256

#define _GPIO_DIR_NONE   0
#define _GPIO_DIR_INPUT  1
#define _GPIO_DIR_OUTPUT 2
#define _GPIO_DIR_ERROR  3

static int     _chip_fd              = -1;
static int     _line_fd[_RPi_GPIO_MAX];
static uint8_t _gpio_dir[_RPi_GPIO_MAX];
static int     _gpio_hal_ready       = 0;

/* I2C file descriptors — one per bus, lazy-opened */
static int _rpi_i2c_fd[16] = {
    -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1
};

/* SPI file descriptors — [bus][cs_line], lazy-opened */
static int _rpi_spi_fd[4][4] = {
    { -1, -1, -1, -1 }, { -1, -1, -1, -1 },
    { -1, -1, -1, -1 }, { -1, -1, -1, -1 },
};

/* ---------------------------------------------------------------------------
 * Lifecycle
 * -------------------------------------------------------------------------*/

static inline void HAL_Init(void) {
    if (_gpio_hal_ready) return;
    for (int i = 0; i < _RPi_GPIO_MAX; i++) { _line_fd[i] = -1; _gpio_dir[i] = _GPIO_DIR_NONE; }
    _chip_fd = open(KRON_GPIO_CHIP, O_RDWR);
    _gpio_hal_ready = 1;
}

static inline void HAL_Cleanup(void) {
    for (int i = 0; i < _RPi_GPIO_MAX; i++) {
        if (_line_fd[i] >= 0) { close(_line_fd[i]); _line_fd[i] = -1; _gpio_dir[i] = _GPIO_DIR_NONE; }
    }
    if (_chip_fd >= 0) { close(_chip_fd); _chip_fd = -1; }
    for (int i = 0; i < 16; i++) {
        if (_rpi_i2c_fd[i] >= 0) { close(_rpi_i2c_fd[i]); _rpi_i2c_fd[i] = -1; }
    }
    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 4; j++) {
            if (_rpi_spi_fd[i][j] >= 0) { close(_rpi_spi_fd[i][j]); _rpi_spi_fd[i][j] = -1; }
        }
    }
    _gpio_hal_ready = 0;
}

/* ---------------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------------*/

static inline void _gpio_release_line(int pin) {
    if (_line_fd[pin] >= 0) { close(_line_fd[pin]); _line_fd[pin] = -1; _gpio_dir[pin] = _GPIO_DIR_NONE; }
}

static inline int _gpio_request_output(int pin) {
    if (_gpio_dir[pin] == _GPIO_DIR_OUTPUT) return 0;
    if (_gpio_dir[pin] == _GPIO_DIR_ERROR)  return -1;
    if (_chip_fd < 0) { _gpio_dir[pin] = _GPIO_DIR_ERROR; return -1; }

    _gpio_release_line(pin);

    struct gpiohandle_request req;
    memset(&req, 0, sizeof(req));
    req.lineoffsets[0] = (uint32_t)pin;
    req.flags = GPIOHANDLE_REQUEST_OUTPUT;
    req.default_values[0] = 0;
    strncpy(req.consumer_label, "kronplc", sizeof(req.consumer_label) - 1);
    req.lines = 1;

    if (ioctl(_chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &req) < 0 || req.fd < 0) {
        _gpio_dir[pin] = _GPIO_DIR_ERROR; return -1;
    }
    _line_fd[pin] = req.fd;
    _gpio_dir[pin] = _GPIO_DIR_OUTPUT;
    return 0;
}

static inline int _gpio_request_input(int pin) {
    if (_gpio_dir[pin] == _GPIO_DIR_INPUT) return 0;
    if (_gpio_dir[pin] == _GPIO_DIR_ERROR) return -1;
    if (_chip_fd < 0) { _gpio_dir[pin] = _GPIO_DIR_ERROR; return -1; }

    _gpio_release_line(pin);

    struct gpiohandle_request req;
    memset(&req, 0, sizeof(req));
    req.lineoffsets[0] = (uint32_t)pin;
    req.flags = GPIOHANDLE_REQUEST_INPUT;
    req.default_values[0] = 0;
    strncpy(req.consumer_label, "kronplc", sizeof(req.consumer_label) - 1);
    req.lines = 1;

    if (ioctl(_chip_fd, GPIO_GET_LINEHANDLE_IOCTL, &req) < 0 || req.fd < 0) {
        _gpio_dir[pin] = _GPIO_DIR_ERROR; return -1;
    }
    _line_fd[pin] = req.fd;
    _gpio_dir[pin] = _GPIO_DIR_INPUT;
    return 0;
}

/* ---------------------------------------------------------------------------
 * GPIO Write
 * -------------------------------------------------------------------------*/

static inline void GPIO_Write_Call(GPIO_Write *inst) {
    inst->ENO = inst->EN;
    inst->OK  = false;
    if (!inst->EN) return;

    int pin = (int)inst->PIN;
    if (pin < 0 || pin >= _RPi_GPIO_MAX) return;

    if (_gpio_request_output(pin) < 0) return;

    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    data.values[0] = inst->VALUE ? 1 : 0;
    inst->OK = (ioctl(_line_fd[pin], GPIOHANDLE_SET_LINE_VALUES_IOCTL, &data) == 0);
}

/* ---------------------------------------------------------------------------
 * GPIO Read
 * -------------------------------------------------------------------------*/

static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO   = inst->EN;
    inst->VALUE = false;
    if (!inst->EN) return;

    int pin = (int)inst->PIN;
    if (pin < 0 || pin >= _RPi_GPIO_MAX) return;

    if (_gpio_request_input(pin) < 0) return;

    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    if (ioctl(_line_fd[pin], GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) == 0) {
        inst->VALUE = (bool)data.values[0];
    }
}

/* ---------------------------------------------------------------------------
 * GPIO SetMode  (MODE: 0 = input, 1 = output)
 * -------------------------------------------------------------------------*/

static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO = inst->EN;
    inst->OK  = false;
    if (!inst->EN) return;

    int pin = (int)inst->PIN;
    if (pin < 0 || pin >= _RPi_GPIO_MAX) return;

    if (inst->MODE == 0)
        inst->OK = (_gpio_request_input(pin)  == 0);
    else
        inst->OK = (_gpio_request_output(pin) == 0);
}

/* ---------------------------------------------------------------------------
 * PWM  (TODO)
 * -------------------------------------------------------------------------*/
static inline void HAL_PWM_Call(HAL_PWM *inst, uint8_t ch) {
    (void)ch;
    inst->ENO    = inst->EN;
    inst->ACTIVE = inst->EN;
    /* TODO: /sys/class/pwm/ */
}

/* ---------------------------------------------------------------------------
 * SPI  (single-byte — TODO: full implementation)
 * -------------------------------------------------------------------------*/
static inline void HAL_SPI_Call(HAL_SPI *inst, uint8_t ch) {
    (void)ch;
    inst->ENO     = inst->EN;
    inst->RX_DATA = 0;
    inst->DONE    = inst->EN;
    /* TODO: /dev/spidevN.0 ioctl */
}

/* ---------------------------------------------------------------------------
 * SPI Burst Transfer  — /dev/spidevN.M via SPI_IOC_MESSAGE ioctl
 *   ch = SPI bus number (N in /dev/spidevN.M)
 *   inst->CS = CS line (M)
 * -------------------------------------------------------------------------*/

static inline int _rpi_spi_open(uint8_t bus, uint8_t cs, uint8_t mode, int32_t clk_hz) {
    if (bus >= 4 || cs >= 4) return -1;
    if (_rpi_spi_fd[bus][cs] >= 0) return _rpi_spi_fd[bus][cs];

    char path[24];
    snprintf(path, sizeof(path), "/dev/spidev%d.%d", (int)bus, (int)cs);
    int fd = open(path, O_RDWR);
    if (fd < 0) return -1;

    uint8_t m    = mode & 3u;
    uint8_t bits = 8;
    uint32_t spd = (clk_hz > 0) ? (uint32_t)clk_hz : 1000000u;
    ioctl(fd, SPI_IOC_WR_MODE,          &m);
    ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, &bits);
    ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ,  &spd);

    _rpi_spi_fd[bus][cs] = fd;
    return fd;
}

static inline void HAL_SPI_BurstTransfer_Call(HAL_SPI_BurstTransfer *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (inst->LEN == 0 || inst->LEN > 255) { inst->ERR_ID = 1; return; }

    int fd = _rpi_spi_open(ch, inst->CS, inst->MODE, inst->CLK_HZ);
    if (fd < 0) { inst->ERR_ID = 2; return; }

    uint8_t tx_buf[255], rx_buf[255];
    if (inst->TX_BUF) memcpy(tx_buf, inst->TX_BUF, inst->LEN);
    else              memset(tx_buf, 0,             inst->LEN);

    struct spi_ioc_transfer tr;
    memset(&tr, 0, sizeof(tr));
    tr.tx_buf        = (unsigned long)tx_buf;
    tr.rx_buf        = (unsigned long)rx_buf;
    tr.len           = inst->LEN;
    tr.speed_hz      = (inst->CLK_HZ > 0) ? (uint32_t)inst->CLK_HZ : 1000000u;
    tr.bits_per_word = 8;
    tr.cs_change     = 0;

    if (ioctl(fd, SPI_IOC_MESSAGE(1), &tr) >= 0) {
        if (inst->RX_BUF) memcpy(inst->RX_BUF, rx_buf, inst->LEN);
        inst->DONE = true;
    } else {
        inst->ERR_ID = 3;
    }
}

/* ---------------------------------------------------------------------------
 * I2C  — /dev/i2c-N via linux/i2c-dev.h ioctl, no external library
 *   ch 0 → /dev/i2c-0   ch 1 → /dev/i2c-1 (standard GPIO2/3 SDA/SCL)
 *   ch 2 → /dev/i2c-2   ch 3 → /dev/i2c-3 (RPi4/5 with DT overlay)
 * -------------------------------------------------------------------------*/

#ifndef KRON_I2C0
#define KRON_I2C0 "/dev/i2c-0"
#endif
#ifndef KRON_I2C1
#define KRON_I2C1 "/dev/i2c-1"
#endif
#ifndef KRON_I2C2
#define KRON_I2C2 "/dev/i2c-2"
#endif
#ifndef KRON_I2C3
#define KRON_I2C3 "/dev/i2c-3"
#endif

static inline int _rpi_i2c_open(uint8_t ch) {
    if (ch >= 16) return -1;
    if (_rpi_i2c_fd[ch] < 0) {
        char path[24];
        snprintf(path, sizeof(path), "/dev/i2c-%u", (unsigned)ch);
        _rpi_i2c_fd[ch] = open(path, O_RDWR);
    }
    return _rpi_i2c_fd[ch];
}

static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _rpi_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t reg = inst->REG;
    if (write(fd, &reg, 1) != 1) { inst->ERR_ID = 3; return; }
    uint8_t buf = 0;
    if (read(fd, &buf, 1) == 1) { inst->DATA = buf; inst->OK = true; }
    else inst->ERR_ID = 3;
}

static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _rpi_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t buf[2] = { inst->REG, inst->DATA };
    inst->OK = (write(fd, buf, 2) == 2);
    if (!inst->OK) inst->ERR_ID = 3;
}

static inline void HAL_I2C_BurstRead_Call(HAL_I2C_BurstRead *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (!inst->BUFFER || inst->LEN == 0) { inst->ERR_ID = 1; return; }
    int fd = _rpi_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t reg = inst->REG;
    if (write(fd, &reg, 1) != 1) { inst->ERR_ID = 3; return; }
    ssize_t n = read(fd, inst->BUFFER, inst->LEN);
    if (n == (ssize_t)inst->LEN) inst->OK = true;
    else inst->ERR_ID = 3;
}

static inline void HAL_I2C_BurstWrite_Call(HAL_I2C_BurstWrite *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (!inst->BUFFER || inst->LEN == 0 || inst->LEN > 255) { inst->ERR_ID = 1; return; }
    int fd = _rpi_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    /* Frame: [REG, DATA0, DATA1, ..., DATA(LEN-1)] */
    uint8_t txbuf[256];
    txbuf[0] = inst->REG;
    memcpy(txbuf + 1, inst->BUFFER, inst->LEN);
    inst->OK = (write(fd, txbuf, (size_t)inst->LEN + 1) == (ssize_t)(inst->LEN + 1));
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * UART
 *   UART0 = /dev/ttyAMA0  (primary PL011 — GPIO14/15)
 *   UART1 = /dev/ttyS0    (mini UART — lower priority, less reliable >115200)
 *   UART2..5 = /dev/ttyAMA1..4  (additional PL011 — RPi4/5, needs DT overlay)
 * -------------------------------------------------------------------------*/
#ifndef KRON_UART0
#define KRON_UART0 "/dev/ttyAMA0"
#endif
#ifndef KRON_UART1
#define KRON_UART1 "/dev/ttyS0"
#endif
#ifndef KRON_UART2
#define KRON_UART2 "/dev/ttyAMA1"
#endif
#ifndef KRON_UART3
#define KRON_UART3 "/dev/ttyAMA2"
#endif
#ifndef KRON_UART4
#define KRON_UART4 "/dev/ttyAMA3"
#endif
#ifndef KRON_UART5
#define KRON_UART5 "/dev/ttyAMA4"
#endif

static const char *const _rpi_uart_devs[6] = {
    KRON_UART0, KRON_UART1, KRON_UART2,
    KRON_UART3, KRON_UART4, KRON_UART5,
};
static int _rpi_uart_fd[6] = { -1, -1, -1, -1, -1, -1 };

static inline speed_t _rpi_baud_to_speed(int32_t baud) {
    switch (baud) {
        case 9600:   return B9600;
        case 19200:  return B19200;
        case 38400:  return B38400;
        case 57600:  return B57600;
        case 115200: return B115200;
        case 230400: return B230400;
        case 460800: return B460800;
        case 921600: return B921600;
        default:     return B115200;
    }
}

static inline int _rpi_uart_open(uint8_t ch, int32_t baud) {
    if (ch >= 6) return -1;
    if (_rpi_uart_fd[ch] >= 0) return _rpi_uart_fd[ch];

    int fd = open(_rpi_uart_devs[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    if (tcgetattr(fd, &tty) != 0) { close(fd); return -1; }

    speed_t spd = _rpi_baud_to_speed(baud);
    uint8_t parity = KRON_UART_PortParity(ch);
    uint8_t stop_bits = KRON_UART_PortStopBits(ch);
    cfsetispeed(&tty, spd);
    cfsetospeed(&tty, spd);

    tty.c_cflag  = (tty.c_cflag & ~CSIZE) | CS8;
    tty.c_cflag |= (CLOCAL | CREAD);
    tty.c_cflag &= ~(PARENB | PARODD | CSTOPB | CRTSCTS);
    if (parity == 1) tty.c_cflag |= PARENB;
    else if (parity == 2) tty.c_cflag |= (PARENB | PARODD);
    if (stop_bits == 2) tty.c_cflag |= CSTOPB;
    tty.c_lflag  = 0;
    tty.c_oflag  = 0;
    tty.c_iflag  = 0;
    tty.c_cc[VMIN]  = 0;
    tty.c_cc[VTIME] = 1;

    if (tcsetattr(fd, TCSANOW, &tty) != 0) { close(fd); return -1; }
    _rpi_uart_fd[ch] = fd;
    return fd;
}

static inline void HAL_UART_Send_Call(HAL_UART_Send *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _rpi_uart_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = inst->DATA;
    if (write(fd, &byte, 1) == 1)
        inst->DONE = true;
    else
        inst->ERR_ID = 3;
}

static inline void HAL_UART_Receive_Call(HAL_UART_Receive *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _rpi_uart_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = 0;
    if (read(fd, &byte, 1) == 1) { inst->DATA = byte; inst->READY = true; }
}

/* ---------------------------------------------------------------------------
 * ADC  (RPi has no built-in ADC — stub)
 * -------------------------------------------------------------------------*/
static inline void HAL_ADC_Read_Call(HAL_ADC_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO     = inst->EN;
    inst->VALUE   = 0;
    inst->VOLTAGE = 0.0f;
}

/* ---------------------------------------------------------------------------
 * CAN  (not available on standard RPi — stub)
 * -------------------------------------------------------------------------*/
static inline void HAL_CAN_Send_Call(HAL_CAN_Send *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->DONE = false;
}
static inline void HAL_CAN_Receive_Call(HAL_CAN_Receive *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->READY = false;
}

/* ---------------------------------------------------------------------------
 * PRU  (not available on RPi — stub)
 * -------------------------------------------------------------------------*/
static inline void HAL_PRU_Execute_Call(HAL_PRU_Execute *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->RESULT = 0; inst->DONE = false;
}

/* ---------------------------------------------------------------------------
 * PCM  (TODO)
 * -------------------------------------------------------------------------*/
static inline void PCM_Output_Call(PCM_Output *inst) {
    inst->ENO = inst->EN;
    inst->OK  = inst->EN;
    /* TODO: ALSA PCM output */
}
static inline void PCM_Input_Call(PCM_Input *inst) {
    inst->ENO   = inst->EN;
    inst->DATA  = 0;
    inst->READY = false;
}

/* ---------------------------------------------------------------------------
 * DI / DO  (not on standard RPi — stub; use GPIO blocks instead)
 * -------------------------------------------------------------------------*/
static inline void HAL_DI_Read_Call(HAL_DI_Read *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->VALUE = false;
}
static inline void HAL_DO_Write_Call(HAL_DO_Write *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->OK = false;
}

/* ---------------------------------------------------------------------------
 * Grove  (not natively available on RPi — stub)
 * -------------------------------------------------------------------------*/
static inline void Grove_DigitalRead_Call(Grove_DigitalRead *inst) {
    inst->ENO = inst->EN; inst->VALUE = false;
}
static inline void Grove_DigitalWrite_Call(Grove_DigitalWrite *inst) {
    inst->ENO = inst->EN; inst->OK = false;
}
static inline void Grove_AnalogRead_Call(Grove_AnalogRead *inst) {
    inst->ENO = inst->EN; inst->VALUE = 0; inst->VOLTAGE = 0.0f;
}

#endif /* KRONHAL_RPI_H */
