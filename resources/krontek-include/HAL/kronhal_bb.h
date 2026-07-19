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

/* BeagleBone has two 46-pin headers (P8 and P9). The PLC block input is
 * the physical header pin. To keep a single int encoding we reserve:
 *     1..46    → P9 header (the common one — most GPIO users start here)
 *     101..146 → P8 header (add 100 to the physical pin number)
 * _BB_PHYS_TO_LINE[] maps this to the packed Linux GPIO line number
 * (bank * 32 + offset) on the AM335x SoC; the eventual implementation
 * can split bank/offset back out when opening the correct gpiochip.
 *
 * Only P9 GPIO pins are populated today — P8 entries are placeholders
 * pending a real implementation. Unknown / non-GPIO pins return -1 and
 * surface ERR_ID = 1 (ERR_INVALID_CHANNEL). */
static const int16_t _BB_PHYS_TO_LINE[147] = {
    [0]    = -1,
    /* P9 header — pins 1..46 */
    [1]    = -1, [2]   = -1, [3]   = -1, [4]   = -1,  /* GND/VDD */
    [5]    = -1, [6]   = -1, [7]   = -1, [8]   = -1,  /* VDD/5V */
    [9]    = -1, [10]  = -1,                           /* PWR_BUT / RESET */
    [11]   =  30, [12]  =  60,                         /* GPIO0_30 / GPIO1_28 */
    [13]   =  31, [14]  =  50,                         /* GPIO0_31 / GPIO1_18 */
    [15]   =  48, [16]  =  51,                         /* GPIO1_16 / GPIO1_19 */
    [17]   =   5, [18]  =   4,                         /* GPIO0_5  / GPIO0_4  */
    [19]   =  13, [20]  =  12,                         /* GPIO0_13 / GPIO0_12 */
    [21]   =   3, [22]  =   2,                         /* GPIO0_3  / GPIO0_2  */
    [23]   =  49, [24]  =  15,                         /* GPIO1_17 / GPIO0_15 */
    [25]   = 117, [26]  =  14,                         /* GPIO3_21 / GPIO0_14 */
    [27]   = 115, [28]  = 113,                         /* GPIO3_19 / GPIO3_17 */
    [29]   = 111, [30]  = 112,                         /* GPIO3_15 / GPIO3_16 */
    [31]   = 110, [32]  =  -1,                         /* GPIO3_14 / VDD_ADC */
    [33]   =  -1, [34]  =  -1,                         /* AIN4 / GND_ADC */
    [35]   =  -1, [36]  =  -1,                         /* AIN6 / AIN5 */
    [37]   =  -1, [38]  =  -1,                         /* AIN2 / AIN3 */
    [39]   =  -1, [40]  =  -1,                         /* AIN0 / AIN1 */
    [41]   =  20, [42]  =   7,                         /* GPIO0_20 / GPIO0_7  */
    [43]   =  -1, [44]  =  -1, [45] = -1, [46] = -1,   /* GND */
    /* P8 header — pins 101..146 (TODO: populate when BB HAL is implemented) */
    [101] = -1, [102] = -1, [103] = -1, [104] = -1,
    [105] = -1, [106] = -1, [107] = -1, [108] = -1,
    [109] = -1, [110] = -1, [111] = -1, [112] = -1,
    [113] = -1, [114] = -1, [115] = -1, [116] = -1,
    [117] = -1, [118] = -1, [119] = -1, [120] = -1,
    [121] = -1, [122] = -1, [123] = -1, [124] = -1,
    [125] = -1, [126] = -1, [127] = -1, [128] = -1,
    [129] = -1, [130] = -1, [131] = -1, [132] = -1,
    [133] = -1, [134] = -1, [135] = -1, [136] = -1,
    [137] = -1, [138] = -1, [139] = -1, [140] = -1,
    [141] = -1, [142] = -1, [143] = -1, [144] = -1,
    [145] = -1, [146] = -1,
};

static inline int _bb_resolve_phys_pin(int phys) {
    if (phys < 1 || phys > 146) return -1;
    return (int)_BB_PHYS_TO_LINE[phys];
}

/* Lifecycle */
static inline void HAL_Init(void)    { /* TODO: cape manager / device tree overlay */ }
static inline void HAL_Cleanup(void) {}

/* GPIO */
static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int line = _bb_resolve_phys_pin((int)inst->PIN);
    if (line < 0) { inst->ERR_ID = 1; return; }
    /* TODO: sysfs/gpiod read on /dev/gpiochip<bank> line offset */
    (void)line;
}
static inline void GPIO_Write_Call(GPIO_Write *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int line = _bb_resolve_phys_pin((int)inst->PIN);
    if (line < 0) { inst->ERR_ID = 1; return; }
    /* TODO: sysfs/gpiod write on /dev/gpiochip<bank> line offset */
    (void)line;
    inst->OK = true;
}
static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int line = _bb_resolve_phys_pin((int)inst->PIN);
    if (line < 0) { inst->ERR_ID = 1; return; }
    (void)line;
    inst->OK = true;
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
#ifdef B1000000
        case 1000000: return B1000000;
#endif
#ifdef B1500000
        case 1500000: return B1500000;
#endif
#ifdef B2000000
        case 2000000: return B2000000;
#endif
#ifdef B3000000
        case 3000000: return B3000000;
#endif
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

/* USB Serial */
#ifndef KRON_USB0
#define KRON_USB0 "/dev/ttyUSB0"
#endif
#ifndef KRON_USB1
#define KRON_USB1 "/dev/ttyACM0"
#endif

static const char *const _bb_usb_devs[2] = { KRON_USB0, KRON_USB1 };
static int _bb_usb_fd[2] = { -1, -1 };

static inline int _bb_usb_open(uint8_t ch, int32_t baud) {
    if (ch >= 2) return -1;
    if (_bb_usb_fd[ch] >= 0) return _bb_usb_fd[ch];
    int fd = open(_bb_usb_devs[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
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

    /* Drop DTR low — required by motor-controlled USB devices such as
     * RPLIDAR A1M8 (DTR-high = motor-off). Linux opens with DTR-high by
     * default; without this the motor stalls and the data stream stops. */
    int dtr_flag = TIOCM_DTR;
    ioctl(fd, TIOCMBIC, &dtr_flag);

    _bb_usb_fd[ch] = fd;
    return fd;
}

static inline void HAL_USB_Send_Call(HAL_USB_Send *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _bb_usb_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = inst->DATA;
    if (write(fd, &byte, 1) == 1) inst->DONE = true;
    else inst->ERR_ID = 3;
}

static inline void HAL_USB_Receive_Call(HAL_USB_Receive *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _bb_usb_open(ch, inst->BAUD);
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
