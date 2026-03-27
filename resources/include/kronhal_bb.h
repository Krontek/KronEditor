/*
 * kronhal_bb.h  --  BeagleBone family HAL implementation
 *
 * Targets: bb_black, bb_black_wireless, bb_green, bb_green_wireless,
 *          bb_ai, bb_ai64
 * Uses Linux sysfs / libgpiod for GPIO, /dev/spi*, /dev/i2c-*, PRU, etc.
 *
 * NOTE: This is a skeleton -- real hardware calls will be added
 * when cross-compilation for ARM targets is implemented.
 */
#ifndef KRONHAL_BB_H
#define KRONHAL_BB_H

/* Lifecycle */
static inline void HAL_Init(void)    { /* TODO: cape manager / device tree overlay */ }
static inline void HAL_Cleanup(void) {}

/* GPIO */
static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO = inst->EN;
    /* TODO: sysfs/gpiod read */
    inst->VALUE = false;
}
static inline void GPIO_Write_Call(GPIO_Write *inst) {
    inst->ENO = inst->EN;
    /* TODO: sysfs/gpiod write */
    inst->OK = inst->EN;
}
static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO = inst->EN;
    inst->OK = inst->EN;
}

/* PWM */
static inline void HAL_PWM_Call(HAL_PWM *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: /sys/class/pwm/pwmchipN/ */
    inst->ACTIVE = inst->EN;
}

/* SPI */
static inline void HAL_SPI_Call(HAL_SPI *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    inst->RX_DATA = 0;
    inst->DONE = inst->EN;
}

/* I2C */
static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    inst->DATA = 0;
    inst->OK = inst->EN;
}
static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    inst->OK = inst->EN;
}
static inline void HAL_I2C_BurstRead_Call(HAL_I2C_BurstRead *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN; inst->OK = false; inst->ERR_ID = 1; /* TODO: /dev/i2c-N */
}
static inline void HAL_I2C_BurstWrite_Call(HAL_I2C_BurstWrite *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN; inst->OK = false; inst->ERR_ID = 1; /* TODO: /dev/i2c-N */
}
static inline void HAL_SPI_BurstTransfer_Call(HAL_SPI_BurstTransfer *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN; inst->DONE = false; inst->ERR_ID = 1; /* TODO: /dev/spidevN.M */
}

/* UART
 *   UART0 = /dev/ttyS0  (console — avoid in production)
 *   UART1 = /dev/ttyO1  (OMAP UART1)  …  UART5 = /dev/ttyO5
 */
#ifndef KRON_UART0
#define KRON_UART0 "/dev/ttyS0"
#endif
#ifndef KRON_UART1
#define KRON_UART1 "/dev/ttyO1"
#endif
#ifndef KRON_UART2
#define KRON_UART2 "/dev/ttyO2"
#endif
#ifndef KRON_UART3
#define KRON_UART3 "/dev/ttyO3"
#endif
#ifndef KRON_UART4
#define KRON_UART4 "/dev/ttyO4"
#endif
#ifndef KRON_UART5
#define KRON_UART5 "/dev/ttyO5"
#endif

#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <string.h>

static const char *const _bb_uart_devs[6] = {
    KRON_UART0, KRON_UART1, KRON_UART2,
    KRON_UART3, KRON_UART4, KRON_UART5,
};
static int _bb_uart_fd[6] = { -1, -1, -1, -1, -1, -1 };

static inline speed_t _bb_baud_to_speed(int32_t baud) {
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

static inline int _bb_uart_open(uint8_t ch, int32_t baud) {
    if (ch >= 6) return -1;
    if (_bb_uart_fd[ch] >= 0) return _bb_uart_fd[ch];

    int fd = open(_bb_uart_devs[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    if (tcgetattr(fd, &tty) != 0) { close(fd); return -1; }

    speed_t spd = _bb_baud_to_speed(baud);
    cfsetispeed(&tty, spd);
    cfsetospeed(&tty, spd);

    tty.c_cflag  = (tty.c_cflag & ~CSIZE) | CS8;
    tty.c_cflag |= (CLOCAL | CREAD);
    tty.c_cflag &= ~(PARENB | PARODD | CSTOPB | CRTSCTS);
    tty.c_lflag  = 0;
    tty.c_oflag  = 0;
    tty.c_iflag  = 0;
    tty.c_cc[VMIN]  = 0;
    tty.c_cc[VTIME] = 1;

    if (tcsetattr(fd, TCSANOW, &tty) != 0) { close(fd); return -1; }
    _bb_uart_fd[ch] = fd;
    return fd;
}

static inline void HAL_UART_Send_Call(HAL_UART_Send *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _bb_uart_open(ch, inst->BAUD);
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
    int fd = _bb_uart_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = 0;
    if (read(fd, &byte, 1) == 1) { inst->DATA = byte; inst->READY = true; }
}

/* ADC */
static inline void HAL_ADC_Read_Call(HAL_ADC_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: /sys/bus/iio/devices/iio:device0/in_voltageN_raw */
    inst->VALUE = 0;
    inst->VOLTAGE = 0.0f;
}

/* CAN */
static inline void HAL_CAN_Send_Call(HAL_CAN_Send *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: SocketCAN send */
    inst->DONE = inst->EN;
}
static inline void HAL_CAN_Receive_Call(HAL_CAN_Receive *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: SocketCAN recv */
    inst->ID = 0;
    inst->DATA = 0;
    inst->READY = false;
}

/* PRU */
static inline void HAL_PRU_Execute_Call(HAL_PRU_Execute *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: /dev/rpmsg_pru* */
    inst->RESULT = 0;
    inst->DONE = inst->EN;
}

/* PCM -- not typically used on BB */
static inline void PCM_Output_Call(PCM_Output *inst) {
    inst->ENO = inst->EN; inst->OK = false;
}
static inline void PCM_Input_Call(PCM_Input *inst) {
    inst->ENO = inst->EN; inst->DATA = 0; inst->READY = false;
}

/* Grove (BB Green) */
static inline void Grove_DigitalRead_Call(Grove_DigitalRead *inst) {
    inst->ENO = inst->EN;
    /* TODO: read via I2C grove connector */
    inst->VALUE = false;
}
static inline void Grove_DigitalWrite_Call(Grove_DigitalWrite *inst) {
    inst->ENO = inst->EN;
    inst->OK = inst->EN;
}
static inline void Grove_AnalogRead_Call(Grove_AnalogRead *inst) {
    inst->ENO = inst->EN;
    inst->VALUE = 0;
    inst->VOLTAGE = 0.0f;
}

#endif /* KRONHAL_BB_H */
