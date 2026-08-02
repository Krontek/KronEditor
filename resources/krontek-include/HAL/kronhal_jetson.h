/*
 * kronhal_jetson.h  --  NVIDIA Jetson family HAL implementation
 *
 * Targets: jetson_nano, jetson_tx2, jetson_xavier_nx, jetson_agx_xavier,
 *          jetson_orin_nano, jetson_orin_nx, jetson_agx_orin
 *
 * GPIO: Linux GPIO character device ioctl (linux/gpio.h — no external library)
 *       All Jetson boards expose 40-pin header GPIO via /dev/gpiochip0.
 *       Use `gpioinfo /dev/gpiochip0` on the target to find line offsets.
 *
 * UART: Tegra High-Speed UART (ttyTHS*) — standard termios, no external lib
 * CAN:  SocketCAN (can0/can1) — raw AF_CAN socket, no external lib
 * I2C:  Linux I2C ioctl (/dev/i2c-N) — no external lib
 *
 * Static linking: all implementations use only Linux kernel interfaces and
 * POSIX syscalls — fully compatible with -static on aarch64-none-linux-gnu.
 *
 * Board-specific GPIO chip override (default /dev/gpiochip0):
 *   -DKRON_GPIO_CHIP="/dev/gpiochip2"   (if needed for your carrier board)
 */
#ifndef KRONHAL_JETSON_H
#define KRONHAL_JETSON_H

#include <linux/gpio.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <termios.h>
#include <errno.h>
#include <dirent.h>
#include <limits.h>

#ifndef KRON_GPIO_CHIP
#define KRON_GPIO_CHIP "/dev/gpiochip0"
#endif

/* UART device nodes — Tegra High-Speed UART (ttyTHS) + standard ttyS */
#ifndef KRON_UART0
#define KRON_UART0 "/dev/ttyTHS0"
#endif
#ifndef KRON_UART1
#define KRON_UART1 "/dev/ttyTHS1"
#endif
#ifndef KRON_UART2
#define KRON_UART2 "/dev/ttyTHS2"
#endif
#ifndef KRON_UART3
#define KRON_UART3 "/dev/ttyTHS3"
#endif
#ifndef KRON_UART4
#define KRON_UART4 "/dev/ttyS0"
#endif
#ifndef KRON_UART5
#define KRON_UART5 "/dev/ttyS1"
#endif

/* CAN interface names */
#ifndef KRON_CAN0
#define KRON_CAN0 "can0"
#endif
#ifndef KRON_CAN1
#define KRON_CAN1 "can1"
#endif

/* I2C bus device nodes */
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

#define _JETSON_GPIO_MAX 512

#define _GPIO_DIR_NONE   0
#define _GPIO_DIR_INPUT  1
#define _GPIO_DIR_OUTPUT 2
#define _GPIO_DIR_ERROR  3

static int     _chip_fd              = -1;
static int     _line_fd[_JETSON_GPIO_MAX];
static uint8_t _gpio_dir[_JETSON_GPIO_MAX];
static int     _gpio_hal_ready       = 0;

/* CAN socket file descriptors (lazy-opened) */
static int _can_fd[2] = { -1, -1 };

/* UART file descriptors (lazy-opened) */
static int _uart_fd[6] = { -1, -1, -1, -1, -1, -1 };

/* I2C file descriptors (lazy-opened, one per bus) */
static int _i2c_fd[16] = {
    -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1
};

/* ---------------------------------------------------------------------------
 * PWM sysfs state — supports up to 3 channels
 *
 * The pwmchipN numbers in /sys/class/pwm/ are assigned by the kernel at
 * boot and can shift between reboots (warm vs. cold).  Resolution is done
 * by matching each controller's "device" symlink basename to its known
 * hardware address string — the same technique used in the reference
 * pwm_set.py script for this board.
 *
 * Orin (KRON_JETSON_ORIN) — verified on device (pwmchipN shifts per boot):
 *   ch0 → "3280000.pwm" (pin 15, pwm1, typically pwmchip0)
 *   ch1 → "32e0000.pwm" (pin 32, pwm7, typically pwmchip3)
 *   ch2 → "32c0000.pwm" (pin 33, pwm5, typically pwmchip2)
 * -------------------------------------------------------------------------*/
#define _JETSON_PWM_MAX 3

#ifdef KRON_JETSON_ORIN
static const char * const _pwm_devname[_JETSON_PWM_MAX] = {
    "3280000.pwm",   /* pin 15 — pwm1 */
    "32e0000.pwm",   /* pin 32 — pwm7 */
    "32c0000.pwm",   /* pin 33 — pwm5 */
};
#else
/* Placeholder — populate from `ls -la /sys/class/pwm/pwmchipN/device` on target */
static const char * const _pwm_devname[_JETSON_PWM_MAX] = { NULL, NULL, NULL };
#endif

/* Resolved pwmchipN indices; -1 = not yet looked up (reset if HAL_Cleanup runs). */
static int _pwm_chip_resolved[_JETSON_PWM_MAX] = { -1, -1, -1 };

typedef struct { int8_t exported; int8_t enabled; long period_ns; long duty_ns; } _PwmState;
static _PwmState _pwm_st[_JETSON_PWM_MAX]; /* zero-init = not exported, not enabled */

static inline int _pwm_sysfs_write(const char *path, const char *val) {
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    ssize_t r = write(fd, val, strlen(val));
    close(fd);
    return r < 0 ? -1 : 0;
}

/* Resolve pwmchipN for channel ch by scanning /sys/class/pwm/ and matching
 * the 'device' symlink basename against the known controller address string.
 * Result is cached in _pwm_chip_resolved[ch] for subsequent calls. */
static inline int _pwm_resolve_chip(uint8_t ch) {
    if (ch >= _JETSON_PWM_MAX || !_pwm_devname[ch]) return -1;
    if (_pwm_chip_resolved[ch] >= 0) return _pwm_chip_resolved[ch];

    DIR *d = opendir("/sys/class/pwm");
    if (!d) return -1;
    struct dirent *e;
    int found = -1;
    while ((e = readdir(d)) != NULL && found < 0) {
        if (strncmp(e->d_name, "pwmchip", 7) != 0) continue;
        char link[80], target[PATH_MAX];
        snprintf(link, sizeof(link), "/sys/class/pwm/%s/device", e->d_name);
        ssize_t n = readlink(link, target, sizeof(target) - 1);
        if (n <= 0) continue;
        target[n] = '\0';
        /* basename of the symlink target */
        const char *bn = strrchr(target, '/');
        bn = bn ? bn + 1 : target;
        if (strcmp(bn, _pwm_devname[ch]) == 0)
            found = atoi(e->d_name + 7); /* "pwmchip3" -> 3 */
    }
    closedir(d);
    _pwm_chip_resolved[ch] = found;
    return found;
}

/* ---------------------------------------------------------------------------
 * HAL lifecycle
 * -------------------------------------------------------------------------*/

static inline void HAL_Init(void) {
    if (_gpio_hal_ready) return;
    for (int i = 0; i < _JETSON_GPIO_MAX; i++) {
        _line_fd[i] = -1;
        _gpio_dir[i] = _GPIO_DIR_NONE;
    }
    _chip_fd = open(KRON_GPIO_CHIP, O_RDWR);
    _gpio_hal_ready = 1;
}

static inline void HAL_Cleanup(void) {
    int i;
    for (i = 0; i < _JETSON_GPIO_MAX; i++) {
        if (_line_fd[i] >= 0) { close(_line_fd[i]); _line_fd[i] = -1; _gpio_dir[i] = _GPIO_DIR_NONE; }
    }
    if (_chip_fd >= 0) { close(_chip_fd); _chip_fd = -1; }
    for (i = 0; i < 2; i++) { if (_can_fd[i] >= 0) { close(_can_fd[i]); _can_fd[i] = -1; } }
    for (i = 0; i < 6; i++) { if (_uart_fd[i] >= 0) { close(_uart_fd[i]); _uart_fd[i] = -1; } }
    for (i = 0; i < 16; i++) { if (_i2c_fd[i] >= 0) { close(_i2c_fd[i]); _i2c_fd[i] = -1; } }
    /* Disable and unexport any PWM channels we opened. */
    for (i = 0; i < _JETSON_PWM_MAX; i++) {
        if (_pwm_st[i].exported) {
            int chip_n = _pwm_chip_resolved[i];
            if (chip_n >= 0) {
                char base[48], path[80];
                snprintf(base, sizeof(base), "/sys/class/pwm/pwmchip%d", chip_n);
                if (_pwm_st[i].enabled == 1) {
                    snprintf(path, sizeof(path), "%s/pwm0/enable", base);
                    _pwm_sysfs_write(path, "0");
                }
                snprintf(path, sizeof(path), "%s/unexport", base);
                _pwm_sysfs_write(path, "0");
            }
            _pwm_st[i].exported = 0;
            _pwm_st[i].enabled  = 0;
        }
        _pwm_chip_resolved[i] = -1;
    }
    _gpio_hal_ready = 0;
}

/* ---------------------------------------------------------------------------
 * Physical header pin → Tegra GPIO line offset (within /dev/gpiochip0).
 *
 * All Jetson boards share the same 40-pin header layout, but the Tegra
 * line offsets vary per SoC family (X1 on Nano, Xavier, Orin, etc.). The
 * default table below targets Jetson Nano (Tegra X1) — the most common
 * entry-level Jetson. To build for a different module, override this
 * table by defining one of:
 *
 *     -DKRON_JETSON_TX2     (Tegra X2)
 *     -DKRON_JETSON_XAVIER  (Xavier NX / AGX Xavier)
 *     -DKRON_JETSON_ORIN    (Orin Nano / Orin NX / AGX Orin)
 *
 * -1 = power / ground / non-GPIO pin; surfaces as ERR_ID = 1.
 *
 * Values below are the libgpiod line offsets on /dev/gpiochip0 as
 * reported by `gpioinfo /dev/gpiochip0` on a stock Jetson Nano image
 * (L4T 32.x). On other models, generate the table from `gpioinfo`
 * output for the equivalent header pin signal names.
 * -------------------------------------------------------------------------*/
static const int16_t _JETSON_PHYS_TO_LINE[41] = {
    /*  0 */ -1,
    /*  1 */ -1, /*  2 */ -1,   /* 3V3            | 5V             */
#if defined(KRON_JETSON_ORIN)
    /* Jetson Orin Nano / Orin NX / AGX Orin (Tegra234) — AliCam overlay.
     * Values are the RUNTIME line indices on /dev/gpiochip0 as reported by
     * `gpioinfo` — NOT the TEGRA234_MAIN_GPIO(port,bit) DT macro numbers
     * (those gave 192..196 for port Y, which exceeds the chip's line count
     * and made every line request fail with ERR_ID=3). Port Y starts at
     * kernel line 122: py3=125 / py4=126 verified on device (working
     * bit-bang test); py0/py1/py2 derived from bank contiguity — confirm
     * with `gpioinfo /dev/gpiochip0 | grep -i 'PY\.'` if a new L4T release
     * renumbers the banks.
     * GPIO-capable: pins 13/16/18/22/37 (SPI3→GPIO, port Y py0-py4).
     * PWM (use HAL_PWM_Call, not GPIO): pins 15/32/33 → -1 in this table.
     * UART1: 8/10/11/36. SPI1: 19/21/23/24/26. I2S2: 12/35/38/40.
     * I2C on AON /dev/gpiochip1 (pins 3/5/27/28) → -1 here. */
    /*  3 */ -1, /*  4 */ -1,   /* I2C8 SDA (AON gpiochip1) | 5V           */
    /*  5 */ -1, /*  6 */ -1,   /* I2C8 SCL (AON gpiochip1) | GND          */
    /*  7 */ -1, /*  8 */ -1,   /* AUD_MCLK (pac6)          | UART1 TX     */
    /*  9 */ -1, /* 10 */ -1,   /* GND                      | UART1 RX     */
    /* 11 */ -1, /* 12 */ -1,   /* UART1 RTS                | I2S2 SCLK    */
    /* 13 */ 122,/* 14 */ -1,   /* GPIO py0 (line 122)      | GND          */
    /* 15 */ -1, /* 16 */ 126,  /* PWM0 (3280000.pwm/pn1)   | GPIO py4=126 */
    /* 17 */ -1, /* 18 */ 125,  /* 3V3                      | GPIO py3=125 */
    /* 19 */ -1, /* 20 */ -1,   /* SPI1 MOSI                | GND          */
    /* 21 */ -1, /* 22 */ 123,  /* SPI1 MISO                | GPIO py1=123 */
    /* 23 */ -1, /* 24 */ -1,   /* SPI1 SCK                 | SPI1 CS0     */
    /* 25 */ -1, /* 26 */ -1,   /* GND                      | SPI1 CS1     */
    /* 27 */ -1, /* 28 */ -1,   /* I2C2 SDA (AON gpiochip1) | I2C2 SCL     */
    /* 29 */ -1, /* 30 */ -1,   /* extperiph3 CLK           | GND          */
    /* 31 */ -1, /* 32 */ -1,   /* extperiph4 CLK           | PWM1 (32e0000.pwm) */
    /* 33 */ -1, /* 34 */ -1,   /* PWM2 (32c0000.pwm/ph0)   | GND          */
    /* 35 */ -1, /* 36 */ -1,   /* I2S2 FS                  | UART1 CTS    */
    /* 37 */ 124,/* 38 */ -1,   /* GPIO py2 (line 124)      | I2S2 DIN     */
    /* 39 */ -1, /* 40 */ -1,   /* GND                      | I2S2 DOUT    */
#elif defined(KRON_JETSON_XAVIER) || defined(KRON_JETSON_TX2)
    /* Placeholder for Xavier/TX2: populate from gpioinfo output. */
    /*  3 */ -1, /*  4 */ -1, /*  5 */ -1, /*  6 */ -1,
    /*  7 */ -1, /*  8 */ -1, /*  9 */ -1, /* 10 */ -1,
    /* 11 */ -1, /* 12 */ -1, /* 13 */ -1, /* 14 */ -1,
    /* 15 */ -1, /* 16 */ -1, /* 17 */ -1, /* 18 */ -1,
    /* 19 */ -1, /* 20 */ -1, /* 21 */ -1, /* 22 */ -1,
    /* 23 */ -1, /* 24 */ -1, /* 25 */ -1, /* 26 */ -1,
    /* 27 */ -1, /* 28 */ -1, /* 29 */ -1, /* 30 */ -1,
    /* 31 */ -1, /* 32 */ -1, /* 33 */ -1, /* 34 */ -1,
    /* 35 */ -1, /* 36 */ -1, /* 37 */ -1, /* 38 */ -1,
    /* 39 */ -1, /* 40 */ -1,
#else
    /* Jetson Nano (Tegra X1) — default */
    /*  3 */  75, /*  4 */ -1,   /* I2C1_SDA       | 5V             */
    /*  5 */  74, /*  6 */ -1,   /* I2C1_SCL       | GND            */
    /*  7 */ 216, /*  8 */ -1,   /* AUD_MCLK       | UART TX (THS)  */
    /*  9 */ -1,  /* 10 */ -1,   /* GND            | UART RX (THS)  */
    /* 11 */  50, /* 12 */  79,  /* UART2_RTS      | I2S_4_SCLK     */
    /* 13 */  14, /* 14 */ -1,   /* SPI1_SCK       | GND            */
    /* 15 */ 194, /* 16 */ 232,  /* LCD_TE         | SPI1_CS1       */
    /* 17 */ -1,  /* 18 */  15,  /* 3V3            | SPI1_CS0       */
    /* 19 */ -1,  /* 20 */ -1,   /* SPI0 MOSI (HW) | GND            */
    /* 21 */ -1,  /* 22 */  13,  /* SPI0 MISO (HW) | SPI1_MISO      */
    /* 23 */ -1,  /* 24 */ -1,   /* SPI0 SCK  (HW) | SPI0 CS0 (HW)  */
    /* 25 */ -1,  /* 26 */ -1,   /* GND            | SPI0 CS1 (HW)  */
    /* 27 */ -1,  /* 28 */ -1,   /* I2C0 SDA       | I2C0 SCL       */
    /* 29 */ 149, /* 30 */ -1,   /* GPIO_01        | GND            */
    /* 31 */ 200, /* 32 */ 168,  /* GPIO_11        | GPIO_07 (PWM)  */
    /* 33 */  38, /* 34 */ -1,   /* GPIO_13        | GND            */
    /* 35 */  76, /* 36 */  51,  /* I2S_4_FS       | UART2_CTS      */
    /* 37 */  12, /* 38 */  77,  /* SPI1_MOSI      | I2S_4_SDIN     */
    /* 39 */ -1,  /* 40 */  78,  /* GND            | I2S_4_SDOUT    */
#endif
};

static inline int _jetson_resolve_phys_pin(int phys) {
    if (phys < 1 || phys > 40) return -1;
    return (int)_JETSON_PHYS_TO_LINE[phys];
}

/* ---------------------------------------------------------------------------
 * GPIO internal helpers (identical to RPi HAL — same kernel interface)
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
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int line = _jetson_resolve_phys_pin((int)inst->PIN);
    if (line < 0 || line >= _JETSON_GPIO_MAX) { inst->ERR_ID = 1; return; }

    if (_gpio_request_output(line) < 0) { inst->ERR_ID = 3; return; }

    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    data.values[0] = inst->VALUE ? 1 : 0;
    inst->OK = (ioctl(_line_fd[line], GPIOHANDLE_SET_LINE_VALUES_IOCTL, &data) == 0);
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * GPIO Read
 * -------------------------------------------------------------------------*/

static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int line = _jetson_resolve_phys_pin((int)inst->PIN);
    if (line < 0 || line >= _JETSON_GPIO_MAX) { inst->ERR_ID = 1; return; }

    if (_gpio_request_input(line) < 0) { inst->ERR_ID = 3; return; }

    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    if (ioctl(_line_fd[line], GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) == 0) {
        inst->VALUE = (bool)data.values[0];
    } else {
        inst->ERR_ID = 3;
    }
}

/* ---------------------------------------------------------------------------
 * GPIO SetMode  (MODE: 0 = input, 1 = output)
 * -------------------------------------------------------------------------*/

static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int line = _jetson_resolve_phys_pin((int)inst->PIN);
    if (line < 0 || line >= _JETSON_GPIO_MAX) { inst->ERR_ID = 1; return; }

    if (inst->MODE == 0)
        inst->OK = (_gpio_request_input(line)  == 0);
    else
        inst->OK = (_gpio_request_output(line) == 0);
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * PWM  — sysfs PWM interface (/sys/class/pwm/pwmchipN/pwm0)
 *
 * FREQ (Hz) and DUTY (0.0–100.0 %) are translated to period_ns/duty_cycle_ns
 * and written only when they change to avoid flooding sysfs every scan.
 * Export/unexport is handled automatically; the channel stays exported until
 * HAL_Cleanup() runs.
 *
 * The pwmchipN number is resolved at first use via _pwm_resolve_chip() which
 * scans /sys/class/pwm/ by device address (stable across boots). ERR_ID=1:
 * invalid channel or controller not found; ERR_ID=2: sysfs write fail.
 * -------------------------------------------------------------------------*/
static inline void HAL_PWM_Call(HAL_PWM *inst, uint8_t ch) {
    if (ch >= _JETSON_PWM_MAX) { inst->ENO = 0; inst->ACTIVE = 0; inst->ERR_ID = 1; return; }
    inst->ENO = inst->EN;

    int chip_n = _pwm_resolve_chip(ch);
    if (chip_n < 0) { inst->ACTIVE = 0; inst->ERR_ID = 1; return; }

    char base[48], path[80], buf[24];
    snprintf(base, sizeof(base), "/sys/class/pwm/pwmchip%d", chip_n);

    if (!inst->EN) {
        if (_pwm_st[ch].enabled == 1) {
            snprintf(path, sizeof(path), "%s/pwm0/enable", base);
            _pwm_sysfs_write(path, "0");
            _pwm_st[ch].enabled = 0;
        }
        inst->ACTIVE = 0;
        return;
    }

    /* Export channel on first use — EBUSY means already exported, that's fine. */
    if (!_pwm_st[ch].exported) {
        snprintf(path, sizeof(path), "%s/export", base);
        _pwm_sysfs_write(path, "0"); /* ignore return: EBUSY = already exported */
        _pwm_st[ch].exported = 1;
    }

    float freq = inst->FREQ > 0.001f ? inst->FREQ : 1.0f;
    long period_ns = (long)(1000000000.0f / freq);
    if (period_ns < 1) period_ns = 1;
    float d = inst->DUTY < 0.0f ? 0.0f : (inst->DUTY > 100.0f ? 100.0f : inst->DUTY);
    long duty_ns = (long)((float)period_ns * d / 100.0f);

    if (period_ns != _pwm_st[ch].period_ns || duty_ns != _pwm_st[ch].duty_ns) {
        /* Disable before changing period; set duty=0 first to satisfy kernel
         * constraint: duty_cycle must always be <= period. */
        if (_pwm_st[ch].enabled == 1) {
            snprintf(path, sizeof(path), "%s/pwm0/enable", base);
            _pwm_sysfs_write(path, "0");
        }
        snprintf(path, sizeof(path), "%s/pwm0/duty_cycle", base);
        _pwm_sysfs_write(path, "0");
        snprintf(path, sizeof(path), "%s/pwm0/period", base);
        snprintf(buf, sizeof(buf), "%ld", period_ns);
        _pwm_sysfs_write(path, buf);
        snprintf(path, sizeof(path), "%s/pwm0/duty_cycle", base);
        snprintf(buf, sizeof(buf), "%ld", duty_ns);
        _pwm_sysfs_write(path, buf);
        _pwm_st[ch].period_ns = period_ns;
        _pwm_st[ch].duty_ns   = duty_ns;
        /* Re-enable if it was running before the period change. */
        if (_pwm_st[ch].enabled == 1) {
            snprintf(path, sizeof(path), "%s/pwm0/enable", base);
            _pwm_sysfs_write(path, "1");
        }
    }

    if (_pwm_st[ch].enabled != 1) {
        snprintf(path, sizeof(path), "%s/pwm0/enable", base);
        if (_pwm_sysfs_write(path, "1") == 0) {
            _pwm_st[ch].enabled = 1;
        } else {
            inst->ACTIVE = 0; inst->ERR_ID = 2; return;
        }
    }

    inst->ACTIVE = 1;
    inst->ERR_ID = 0;
}

/* ---------------------------------------------------------------------------
 * SPI  — Linux SPI device ioctl (/dev/spidevN.M)
 * -------------------------------------------------------------------------*/
#include <linux/spi/spidev.h>

static int _spi_fd[4][4] = {
    { -1,-1,-1,-1 }, { -1,-1,-1,-1 },
    { -1,-1,-1,-1 }, { -1,-1,-1,-1 },
};

static inline int _spi_open(uint8_t bus, uint8_t cs, uint8_t mode, int32_t clk_hz);

/* Single-byte SPI — one full-duplex byte on /dev/spidev<ch>.<CS>.
 * (was a fake DONE=EN stub; shares the burst block's fd cache) */
static inline void HAL_SPI_Call(HAL_SPI *inst, uint8_t ch) {
    inst->ENO     = inst->EN;
    inst->RX_DATA = 0;
    inst->DONE    = false;
    inst->ERR_ID  = 0;
    if (!inst->EN) return;
    uint8_t cs = (inst->CS >= 0 && inst->CS < 4) ? (uint8_t)inst->CS : 0;
    int fd = _spi_open(ch, cs, 0, inst->CLK_HZ);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t tx = inst->TX_DATA, rx = 0;
    struct spi_ioc_transfer tr;
    memset(&tr, 0, sizeof(tr));
    tr.tx_buf = (unsigned long)(uintptr_t)&tx;
    tr.rx_buf = (unsigned long)(uintptr_t)&rx;
    tr.len    = 1;
    if (ioctl(fd, SPI_IOC_MESSAGE(1), &tr) < 1) { inst->ERR_ID = 3; return; }
    inst->RX_DATA = rx;
    inst->DONE    = true;
}

static inline int _spi_open(uint8_t bus, uint8_t cs, uint8_t mode, int32_t clk_hz) {
    if (bus >= 4 || cs >= 4) return -1;
    if (_spi_fd[bus][cs] >= 0) return _spi_fd[bus][cs];
    char path[24];
    snprintf(path, sizeof(path), "/dev/spidev%d.%d", (int)bus, (int)cs);
    int fd = open(path, O_RDWR);
    if (fd < 0) return -1;
    uint8_t m = mode & 3u, bits = 8;
    uint32_t spd = (clk_hz > 0) ? (uint32_t)clk_hz : 1000000u;
    ioctl(fd, SPI_IOC_WR_MODE,          &m);
    ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, &bits);
    ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ,  &spd);
    _spi_fd[bus][cs] = fd;
    return fd;
}

static inline void HAL_SPI_BurstTransfer_Call(HAL_SPI_BurstTransfer *inst, uint8_t ch) {
    inst->ENO = inst->EN; inst->DONE = false; inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (inst->LEN == 0 || inst->LEN > 255) { inst->ERR_ID = 1; return; }
    int fd = _spi_open(ch, inst->CS, inst->MODE, inst->CLK_HZ);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t tx_buf[255], rx_buf[255];
    if (inst->TX_BUF) memcpy(tx_buf, inst->TX_BUF, inst->LEN);
    else              memset(tx_buf, 0,             inst->LEN);
    struct spi_ioc_transfer tr;
    memset(&tr, 0, sizeof(tr));
    tr.tx_buf = (unsigned long)tx_buf; tr.rx_buf = (unsigned long)rx_buf;
    tr.len = inst->LEN;
    tr.speed_hz = (inst->CLK_HZ > 0) ? (uint32_t)inst->CLK_HZ : 1000000u;
    tr.bits_per_word = 8;
    if (ioctl(fd, SPI_IOC_MESSAGE(1), &tr) >= 0) {
        if (inst->RX_BUF) memcpy(inst->RX_BUF, rx_buf, inst->LEN);
        inst->DONE = true;
    } else { inst->ERR_ID = 3; }
}

/* ---------------------------------------------------------------------------
 * I2C  — Linux I2C ioctl (/dev/i2c-N)
 *
 * Per-channel device-node overrides: the transpiler emits
 * `#define KRON_I2C<n> "/dev/i2c-<m>"` (from the editor's interface config)
 * before including this header, so logical channel n opens that node instead
 * of /dev/i2c-n. Needed where the header bus number differs from the logical
 * port id — e.g. AGX Orin header pins 3/5 are I2C8 (typically /dev/i2c-7),
 * not /dev/i2c-1. Default: identity (/dev/i2c-<ch>).
 * -------------------------------------------------------------------------*/
#include <linux/i2c-dev.h>

static inline const char *_i2c_devnode(uint8_t ch, char *buf, size_t n) {
    switch (ch) {
#ifdef KRON_I2C0
    case 0: return KRON_I2C0;
#endif
#ifdef KRON_I2C1
    case 1: return KRON_I2C1;
#endif
#ifdef KRON_I2C2
    case 2: return KRON_I2C2;
#endif
#ifdef KRON_I2C3
    case 3: return KRON_I2C3;
#endif
#ifdef KRON_I2C4
    case 4: return KRON_I2C4;
#endif
#ifdef KRON_I2C5
    case 5: return KRON_I2C5;
#endif
#ifdef KRON_I2C6
    case 6: return KRON_I2C6;
#endif
#ifdef KRON_I2C7
    case 7: return KRON_I2C7;
#endif
    default: break;
    }
    snprintf(buf, n, "/dev/i2c-%u", (unsigned)ch);
    return buf;
}

static inline int _i2c_open(uint8_t ch) {
    if (ch >= 16) return -1;
    if (_i2c_fd[ch] < 0) {
        char path[24];
        _i2c_fd[ch] = open(_i2c_devnode(ch, path, sizeof(path)), O_RDWR);
    }
    return _i2c_fd[ch];
}

static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, uint8_t ch) {
    inst->ENO  = inst->EN;
    inst->DATA = 0;
    inst->OK   = false;
    if (!inst->EN) return;

    int fd = _i2c_open(ch);
    if (fd < 0) return;

    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) return;

    uint8_t reg = inst->REG;
    if (write(fd, &reg, 1) != 1) return;

    uint8_t buf = 0;
    if (read(fd, &buf, 1) == 1) {
        inst->DATA = buf;
        inst->OK   = true;
    }
}

static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, uint8_t ch) {
    inst->ENO = inst->EN;
    inst->OK  = false;
    if (!inst->EN) return;

    int fd = _i2c_open(ch);
    if (fd < 0) return;

    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) return;

    uint8_t buf[2] = { inst->REG, inst->DATA };
    inst->OK = (write(fd, buf, 2) == 2);
}

static inline void HAL_I2C_BurstRead_Call(HAL_I2C_BurstRead *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (!inst->BUFFER || inst->LEN == 0) { inst->ERR_ID = 1; return; }
    int fd = _i2c_open(ch);
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
    int fd = _i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t txbuf[256];
    txbuf[0] = inst->REG;
    memcpy(txbuf + 1, inst->BUFFER, inst->LEN);
    inst->OK = (write(fd, txbuf, (size_t)inst->LEN + 1) == (ssize_t)(inst->LEN + 1));
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * UART  — Tegra High-Speed UART (ttyTHS*) via termios, no external lib
 * -------------------------------------------------------------------------*/

static const char * const _uart_devs[6] = {
    KRON_UART0, KRON_UART1, KRON_UART2, KRON_UART3, KRON_UART4, KRON_UART5
};

static inline speed_t _baud_to_speed(int32_t baud) {
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

static inline int _uart_open(uint8_t ch, int32_t baud) {
    if (ch >= 6) return -1;
    if (_uart_fd[ch] < 0) {
        int fd = open(_uart_devs[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
        if (fd < 0) return -1;

        struct termios tty;
        memset(&tty, 0, sizeof(tty));
        if (tcgetattr(fd, &tty) != 0) { close(fd); return -1; }

        speed_t spd = _baud_to_speed(baud);
        uint8_t parity = KRON_UART_PortParity(ch);
        uint8_t stop_bits = KRON_UART_PortStopBits(ch);
        cfsetispeed(&tty, spd);
        cfsetospeed(&tty, spd);

        tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;
        tty.c_cflag |= (CLOCAL | CREAD);
        tty.c_cflag &= ~(PARENB | PARODD | CSTOPB | CRTSCTS);
        if (parity == 1) tty.c_cflag |= PARENB;
        else if (parity == 2) tty.c_cflag |= (PARENB | PARODD);
        if (stop_bits == 2) tty.c_cflag |= CSTOPB;
        tty.c_lflag  = 0;
        tty.c_oflag  = 0;
        tty.c_iflag  = IGNBRK;   /* Jetson THS UART: suppress BREAK→EIO */
        tty.c_cc[VMIN]  = 0;
        tty.c_cc[VTIME] = 1;

        if (tcsetattr(fd, TCSANOW, &tty) != 0) { close(fd); return -1; }
        _uart_fd[ch] = fd;
    }
    return _uart_fd[ch];
}

static inline void HAL_UART_Send_Call(HAL_UART_Send *inst, uint8_t ch) {
    inst->ENO  = inst->EN;
    inst->DONE = false;
    if (!inst->EN) return;

    int fd = _uart_open(ch, inst->BAUD);
    if (fd < 0) return;

    uint8_t byte = inst->DATA;
    inst->DONE = (write(fd, &byte, 1) == 1);
}

static inline void HAL_UART_Receive_Call(HAL_UART_Receive *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int fd = _uart_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }

    uint8_t byte = 0;
    ssize_t n = read(fd, &byte, 1);
    if (n == 1) {
        inst->DATA  = byte;
        inst->READY = true;
    } else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK
                      && errno != EINTR  && errno != EIO) {
        inst->ERR_ID = 3;
    }
}

/* ---------------------------------------------------------------------------
 * USB Serial
 * -------------------------------------------------------------------------*/
#ifndef KRON_USB0
#define KRON_USB0 "/dev/ttyUSB0"
#endif
#ifndef KRON_USB1
#define KRON_USB1 "/dev/ttyUSB1"
#endif
#ifndef KRON_USB2
#define KRON_USB2 "/dev/ttyACM0"
#endif
#ifndef KRON_USB3
#define KRON_USB3 "/dev/ttyACM1"
#endif
#ifndef KRON_USB4
#define KRON_USB4 "/dev/ttyUSB2"
#endif

static const char *const _usb_devs[5] = {
    KRON_USB0, KRON_USB1, KRON_USB2, KRON_USB3, KRON_USB4,
};
static int _usb_fd[5] = { -1, -1, -1, -1, -1 };

static inline int _usb_open(uint8_t ch, int32_t baud) {
    if (ch >= 5) return -1;
    if (_usb_fd[ch] >= 0) return _usb_fd[ch];

    int fd = open(_usb_devs[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    if (tcgetattr(fd, &tty) != 0) { close(fd); return -1; }

    speed_t spd = _baud_to_speed(baud);
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
     * RPLIDAR A1M8 (DTR-high = motor-off). Linux opens with DTR-high
     * by default; without this the motor stalls a few hundred ms after
     * open() and the data stream stops. */
    int dtr_flag = TIOCM_DTR;
    ioctl(fd, TIOCMBIC, &dtr_flag);

    _usb_fd[ch] = fd;
    return fd;
}

static inline void HAL_USB_Send_Call(HAL_USB_Send *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _usb_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = inst->DATA;
    if (write(fd, &byte, 1) == 1)
        inst->DONE = true;
    else
        inst->ERR_ID = 3;
}

static inline void HAL_USB_Receive_Call(HAL_USB_Receive *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->READY  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _usb_open(ch, inst->BAUD);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    uint8_t byte = 0;
    ssize_t n = read(fd, &byte, 1);
    if (n == 1) {
        inst->DATA  = byte;
        inst->READY = true;
    } else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK
                      && errno != EINTR  && errno != EIO) {
        inst->ERR_ID = 3;
    }
}

/* ---------------------------------------------------------------------------
 * ADC  (Jetson has no built-in ADC on 40-pin header — stub)
 * -------------------------------------------------------------------------*/
/* Jetson dev kits expose no user ADC — fail loudly instead of returning a
 * silent 0 that reads like a real measurement. Use an I2C/SPI ADC instead. */
static inline void HAL_ADC_Read_Call(HAL_ADC_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO     = inst->EN;
    inst->VALUE   = 0;
    inst->VOLTAGE = 0.0f;
    inst->ERR_ID  = inst->EN ? 1 : 0;
}

/* ---------------------------------------------------------------------------
 * CAN  — SocketCAN (can0 / can1), no external library required
 * -------------------------------------------------------------------------*/

static const char * const _can_ifaces[2] = { KRON_CAN0, KRON_CAN1 };

static inline int _can_open(uint8_t ch) {
    if (ch >= 2) return -1;
    if (_can_fd[ch] >= 0) return _can_fd[ch];

    int fd = socket(AF_CAN, SOCK_RAW, CAN_RAW);
    if (fd < 0) return -1;

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, _can_ifaces[ch], IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFINDEX, &ifr) < 0) { close(fd); return -1; }

    struct sockaddr_can addr;
    memset(&addr, 0, sizeof(addr));
    addr.can_family  = AF_CAN;
    addr.can_ifindex = ifr.ifr_ifindex;
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { close(fd); return -1; }

    /* Non-blocking reads */
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    _can_fd[ch] = fd;
    return fd;
}

static inline void HAL_CAN_Send_Call(HAL_CAN_Send *inst, uint8_t ch) {
    inst->ENO  = inst->EN;
    inst->DONE = false;
    if (!inst->EN) return;

    int fd = _can_open(ch);
    if (fd < 0) return;

    struct can_frame frame;
    memset(&frame, 0, sizeof(frame));
    frame.can_id  = (uint32_t)inst->ID & CAN_SFF_MASK;
    frame.can_dlc = (inst->DLC > 8) ? 8 : (uint8_t)inst->DLC;
    if (frame.can_dlc > 0) frame.data[0] = inst->DATA;

    inst->DONE = (write(fd, &frame, sizeof(frame)) == (ssize_t)sizeof(frame));
}

static inline void HAL_CAN_Receive_Call(HAL_CAN_Receive *inst, uint8_t ch) {
    inst->ENO   = inst->EN;
    inst->READY = false;
    inst->DATA  = 0;
    inst->ID    = 0;
    if (!inst->EN) return;

    int fd = _can_open(ch);
    if (fd < 0) return;

    struct can_frame frame;
    ssize_t n = read(fd, &frame, sizeof(frame));
    if (n == (ssize_t)sizeof(frame)) {
        if (inst->FILTER_ID == 0 || (int32_t)(frame.can_id & CAN_SFF_MASK) == inst->FILTER_ID) {
            inst->ID    = (int32_t)(frame.can_id & CAN_SFF_MASK);
            inst->DATA  = (frame.can_dlc > 0) ? frame.data[0] : 0;
            inst->READY = true;
        }
    }
}

/* ---------------------------------------------------------------------------
 * PRU  (not available on Jetson — stub)
 * -------------------------------------------------------------------------*/
static inline void HAL_PRU_Execute_Call(HAL_PRU_Execute *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->RESULT = 0; inst->DONE = false;
}

/* ---------------------------------------------------------------------------
 * PCM  (TODO: ALSA)
 * -------------------------------------------------------------------------*/
static inline void PCM_Output_Call(PCM_Output *inst) {
    inst->ENO = inst->EN; inst->OK = inst->EN;
}
static inline void PCM_Input_Call(PCM_Input *inst) {
    inst->ENO = inst->EN; inst->DATA = 0; inst->READY = false;
}

/* ---------------------------------------------------------------------------
 * Grove  (not available on Jetson — stub)
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

/* ---------------------------------------------------------------------------
 * DI / DO  (not on standard Jetson — stub; use GPIO blocks instead)
 * -------------------------------------------------------------------------*/
static inline void HAL_DI_Read_Call(HAL_DI_Read *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->VALUE = false;
}
static inline void HAL_DO_Write_Call(HAL_DO_Write *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->OK = false;
}

#endif /* KRONHAL_JETSON_H */
