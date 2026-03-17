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
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

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
 * SPI  (TODO)
 * -------------------------------------------------------------------------*/
static inline void HAL_SPI_Call(HAL_SPI *inst, uint8_t ch) {
    (void)ch;
    inst->ENO     = inst->EN;
    inst->RX_DATA = 0;
    inst->DONE    = inst->EN;
    /* TODO: /dev/spidevN.0 ioctl */
}

/* ---------------------------------------------------------------------------
 * I2C  (TODO)
 * -------------------------------------------------------------------------*/
static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO  = inst->EN;
    inst->DATA = 0;
    inst->OK   = inst->EN;
    /* TODO: /dev/i2c-N ioctl */
}
static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    inst->OK  = inst->EN;
    /* TODO: /dev/i2c-N ioctl */
}

/* ---------------------------------------------------------------------------
 * UART  (TODO)
 * -------------------------------------------------------------------------*/
static inline void HAL_UART_Send_Call(HAL_UART_Send *inst, uint8_t ch) {
    (void)ch;
    inst->ENO  = inst->EN;
    inst->DONE = inst->EN;
    /* TODO: /dev/ttyAMA0 write */
}
static inline void HAL_UART_Receive_Call(HAL_UART_Receive *inst, uint8_t ch) {
    (void)ch;
    inst->ENO   = inst->EN;
    inst->DATA  = 0;
    inst->READY = false;
    /* TODO: /dev/ttyAMA0 read */
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
