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
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <termios.h>
#include <errno.h>
#include <dirent.h>

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

/* PWM sysfs state. The detection phase probes /sys/class/pwm/pwmchipN to
 * find the first chip that exposes >= KRON_PWM_MAX channels, and caches
 * the result for the rest of the process. On Pi 5 the RP1 PWM typically
 * shows up as pwmchip0 after `dtoverlay=pwm-2chan`; on Pi 4 and earlier
 * it is the legacy BCM PWM peripheral, also at pwmchip0.
 *
 * Per channel we cache:
 *   - duty / period / enable file descriptors (one-time open after export)
 *   - last-written period (ns), duty (ns), and enable flag, so we can
 *     skip sysfs writes when the value has not changed — the per-scan
 *     overhead collapses to zero on a steady-state duty cycle.
 *
 * Only two channels are usable per the hardware constraint (each PWM
 * channel drives exactly one GPIO, and both candidate pins for a given
 * channel share the same sysfs line), so writes to ch >= KRON_PWM_MAX
 * are rejected with ERR_INVALID_CHANNEL. */
#define KRON_PWM_MAX 2

static int      _rpi_pwm_chip          = -1;   /* -1 = not probed; -2 = absent; >=0 = chip index */
static int      _rpi_pwm_exported[KRON_PWM_MAX] = { 0 };
static int      _rpi_pwm_period_fd[KRON_PWM_MAX] = { -1, -1 };
static int      _rpi_pwm_duty_fd  [KRON_PWM_MAX] = { -1, -1 };
static int      _rpi_pwm_enable_fd[KRON_PWM_MAX] = { -1, -1 };
static uint64_t _rpi_pwm_last_period_ns[KRON_PWM_MAX] = { 0 };
static uint64_t _rpi_pwm_last_duty_ns  [KRON_PWM_MAX] = { 0 };
static int      _rpi_pwm_last_enabled  [KRON_PWM_MAX] = { 0 };

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
    /* Disable exported PWM channels and release their fds. The channel
     * export is intentionally NOT unexported — leaving the sysfs entry in
     * place makes restart-without-reboot faster and avoids a window where
     * the line floats high-impedance during redeploy. */
    for (int i = 0; i < KRON_PWM_MAX; i++) {
        if (_rpi_pwm_enable_fd[i] >= 0) {
            lseek(_rpi_pwm_enable_fd[i], 0, SEEK_SET);
            (void)!write(_rpi_pwm_enable_fd[i], "0", 1);
            close(_rpi_pwm_enable_fd[i]); _rpi_pwm_enable_fd[i] = -1;
        }
        if (_rpi_pwm_duty_fd[i]   >= 0) { close(_rpi_pwm_duty_fd[i]);   _rpi_pwm_duty_fd[i]   = -1; }
        if (_rpi_pwm_period_fd[i] >= 0) { close(_rpi_pwm_period_fd[i]); _rpi_pwm_period_fd[i] = -1; }
        _rpi_pwm_exported[i]       = 0;
        _rpi_pwm_last_period_ns[i] = 0;
        _rpi_pwm_last_duty_ns[i]   = 0;
        _rpi_pwm_last_enabled[i]   = 0;
    }
    _rpi_pwm_chip = -1;
    _gpio_hal_ready = 0;
}

/* ---------------------------------------------------------------------------
 * Physical header pin → BCM GPIO line number.
 *
 * The user-facing block input is the physical pin number on the 40-pin
 * header (1..40). The Linux gpiochip API addresses lines by BCM GPIO
 * number, so every GPIO call translates through this table first. The
 * mapping is identical across Pi 3/3+/4/5/Zero 2W because they share the
 * same 40-pin header, so a single table covers the whole family.
 *
 * -1 = power / ground / EEPROM / reserved. Writing to these pins is a
 * user error and surfaces as ERR_ID = 1 (ERR_INVALID_CHANNEL).
 * -------------------------------------------------------------------------*/
static const int8_t _RPI_PHYS_TO_BCM[41] = {
    /*  0 */ -1,                /* 1-indexed, slot 0 is unused */
    /*  1 */ -1, /*  2 */ -1,   /* 3V3           | 5V                 */
    /*  3 */  2, /*  4 */ -1,   /* GPIO2 SDA1    | 5V                 */
    /*  5 */  3, /*  6 */ -1,   /* GPIO3 SCL1    | GND                */
    /*  7 */  4, /*  8 */ 14,   /* GPIO4 GPCLK0  | GPIO14 TXD         */
    /*  9 */ -1, /* 10 */ 15,   /* GND           | GPIO15 RXD         */
    /* 11 */ 17, /* 12 */ 18,   /* GPIO17        | GPIO18 PCM_CLK/PWM */
    /* 13 */ 27, /* 14 */ -1,   /* GPIO27        | GND                */
    /* 15 */ 22, /* 16 */ 23,   /* GPIO22        | GPIO23             */
    /* 17 */ -1, /* 18 */ 24,   /* 3V3           | GPIO24             */
    /* 19 */ 10, /* 20 */ -1,   /* GPIO10 MOSI   | GND                */
    /* 21 */  9, /* 22 */ 25,   /* GPIO9  MISO   | GPIO25             */
    /* 23 */ 11, /* 24 */  8,   /* GPIO11 SCLK   | GPIO8 CE0          */
    /* 25 */ -1, /* 26 */  7,   /* GND           | GPIO7 CE1          */
    /* 27 */ -1, /* 28 */ -1,   /* ID_SD EEPROM  | ID_SC EEPROM       */
    /* 29 */  5, /* 30 */ -1,   /* GPIO5         | GND                */
    /* 31 */  6, /* 32 */ 12,   /* GPIO6         | GPIO12 PWM0        */
    /* 33 */ 13, /* 34 */ -1,   /* GPIO13 PWM1   | GND                */
    /* 35 */ 19, /* 36 */ 16,   /* GPIO19        | GPIO16             */
    /* 37 */ 26, /* 38 */ 20,   /* GPIO26        | GPIO20             */
    /* 39 */ -1, /* 40 */ 21,   /* GND           | GPIO21             */
};

/* Returns the BCM GPIO line, or -1 if the physical pin is not a GPIO.
 * Accepts only pins in the 1..40 range; anything else returns -1. */
static inline int _rpi_resolve_phys_pin(int phys) {
    if (phys < 1 || phys > 40) return -1;
    return (int)_RPI_PHYS_TO_BCM[phys];
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
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int bcm = _rpi_resolve_phys_pin((int)inst->PIN);
    if (bcm < 0 || bcm >= _RPi_GPIO_MAX) { inst->ERR_ID = 1; return; }

    if (_gpio_request_output(bcm) < 0) { inst->ERR_ID = 3; return; }

    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    data.values[0] = inst->VALUE ? 1 : 0;
    inst->OK = (ioctl(_line_fd[bcm], GPIOHANDLE_SET_LINE_VALUES_IOCTL, &data) == 0);
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

    int bcm = _rpi_resolve_phys_pin((int)inst->PIN);
    if (bcm < 0 || bcm >= _RPi_GPIO_MAX) { inst->ERR_ID = 1; return; }

    if (_gpio_request_input(bcm) < 0) { inst->ERR_ID = 3; return; }

    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    if (ioctl(_line_fd[bcm], GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) == 0) {
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

    int bcm = _rpi_resolve_phys_pin((int)inst->PIN);
    if (bcm < 0 || bcm >= _RPi_GPIO_MAX) { inst->ERR_ID = 1; return; }

    if (inst->MODE == 0)
        inst->OK = (_gpio_request_input(bcm)  == 0);
    else
        inst->OK = (_gpio_request_output(bcm) == 0);
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * PWM — Linux sysfs (/sys/class/pwm/pwmchipN/pwmM/…)
 *
 * Pi 5 (RP1) exposes 2 routable PWM channels; Pi 4 and earlier BCM SoCs
 * also expose 2. Each channel drives one GPIO at a time — the kernel
 * overlay (dtoverlay=pwm-2chan) decides which one. The HAL does not
 * switch pins; it just writes duty/period/enable to the sysfs path that
 * the overlay has already wired up.
 *
 * The user must enable PWM in /boot/firmware/config.txt, e.g.:
 *     dtoverlay=pwm-2chan                 # PWM0 on GPIO18, PWM1 on GPIO19
 *     dtoverlay=pwm-2chan,pin=12,func=4   # PWM0 on GPIO12
 * Without the overlay /sys/class/pwm/pwmchipN will be absent, in which
 * case HAL_PWM_Call sets ERR_ID=ERR_IO and ACTIVE=false.
 * -------------------------------------------------------------------------*/

/* Detects the first pwmchip that exposes at least KRON_PWM_MAX channels.
 * Cached for the rest of the process — failure is sticky to avoid
 * hammering sysfs every scan when no PWM overlay is present. */
static inline int _rpi_pwm_detect_chip(void) {
    if (_rpi_pwm_chip != -1) return _rpi_pwm_chip;
    DIR *d = opendir("/sys/class/pwm");
    if (!d) { _rpi_pwm_chip = -2; return -2; }
    struct dirent *ent;
    int best = -2;
    while ((ent = readdir(d)) != NULL) {
        if (strncmp(ent->d_name, "pwmchip", 7) != 0) continue;
        int idx = atoi(ent->d_name + 7);
        if (idx < 0) continue;
        char path[96];
        snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/npwm", idx);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        int npwm = 0;
        if (fscanf(f, "%d", &npwm) != 1) npwm = 0;
        fclose(f);
        if (npwm >= KRON_PWM_MAX) { best = idx; break; }
    }
    closedir(d);
    _rpi_pwm_chip = best;
    return best;
}

static inline int _rpi_pwm_write_str(int fd, const char *s) {
    if (fd < 0) return -1;
    lseek(fd, 0, SEEK_SET);
    size_t len = strlen(s);
    ssize_t n = write(fd, s, len);
    return (n == (ssize_t)len) ? 0 : -1;
}

/* Exports the channel, opens the duty/period/enable fds, and leaves the
 * channel in a clean disabled state. Returns 0 on success. */
static inline int _rpi_pwm_open(uint8_t ch) {
    if (ch >= KRON_PWM_MAX) return -1;
    if (_rpi_pwm_exported[ch]) return 0;
    int chip = _rpi_pwm_detect_chip();
    if (chip < 0) return -1;

    char path[96];

    /* Export (best-effort — EBUSY is fine, the channel is already exported). */
    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/export", chip);
    int exp_fd = open(path, O_WRONLY);
    if (exp_fd >= 0) {
        char buf[8];
        int n = snprintf(buf, sizeof(buf), "%u", (unsigned)ch);
        (void)write(exp_fd, buf, n);
        close(exp_fd);
    }

    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/pwm%u/period", chip, (unsigned)ch);
    _rpi_pwm_period_fd[ch] = open(path, O_WRONLY);
    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/pwm%u/duty_cycle", chip, (unsigned)ch);
    _rpi_pwm_duty_fd[ch] = open(path, O_WRONLY);
    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/pwm%u/enable", chip, (unsigned)ch);
    _rpi_pwm_enable_fd[ch] = open(path, O_WRONLY);

    if (_rpi_pwm_period_fd[ch] < 0 || _rpi_pwm_duty_fd[ch] < 0 || _rpi_pwm_enable_fd[ch] < 0) {
        if (_rpi_pwm_period_fd[ch] >= 0) { close(_rpi_pwm_period_fd[ch]); _rpi_pwm_period_fd[ch] = -1; }
        if (_rpi_pwm_duty_fd[ch]   >= 0) { close(_rpi_pwm_duty_fd[ch]);   _rpi_pwm_duty_fd[ch]   = -1; }
        if (_rpi_pwm_enable_fd[ch] >= 0) { close(_rpi_pwm_enable_fd[ch]); _rpi_pwm_enable_fd[ch] = -1; }
        return -1;
    }

    /* Put the channel in a known state: disabled, duty=0, period=0. This
     * lets the first real write always succeed regardless of what the
     * previous process left behind. */
    (void)_rpi_pwm_write_str(_rpi_pwm_enable_fd[ch], "0");
    (void)_rpi_pwm_write_str(_rpi_pwm_duty_fd[ch],   "0");
    _rpi_pwm_last_period_ns[ch] = 0;
    _rpi_pwm_last_duty_ns[ch]   = 0;
    _rpi_pwm_last_enabled[ch]   = 0;
    _rpi_pwm_exported[ch]       = 1;
    return 0;
}

static inline void HAL_PWM_Call(HAL_PWM *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->ERR_ID = 0;
    inst->ACTIVE = false;

    if (ch >= KRON_PWM_MAX) { inst->ERR_ID = 1; return; }   /* ERR_INVALID_CHANNEL */

    if (!inst->EN) {
        if (_rpi_pwm_exported[ch] && _rpi_pwm_last_enabled[ch]) {
            (void)_rpi_pwm_write_str(_rpi_pwm_enable_fd[ch], "0");
            _rpi_pwm_last_enabled[ch] = 0;
        }
        return;
    }

    if (_rpi_pwm_open(ch) < 0) { inst->ERR_ID = 3; return; } /* ERR_IO */

    /* Clamp inputs. FREQ is in Hz, DUTY is a percentage [0..100]. */
    float freq = inst->FREQ;
    if (freq < 1.0f)      freq = 1.0f;
    if (freq > 1000000.0f) freq = 1000000.0f;
    float duty = inst->DUTY;
    if (duty < 0.0f)   duty = 0.0f;
    if (duty > 100.0f) duty = 100.0f;

    uint64_t period_ns = (uint64_t)(1000000000.0f / freq);
    uint64_t duty_ns   = (uint64_t)((double)period_ns * (double)duty / 100.0);
    if (duty_ns > period_ns) duty_ns = period_ns;

    char buf[32];

    /* The kernel rejects period writes when duty > new period, so whenever
     * the period is changing we first clamp duty to 0, then set the new
     * period, then restore the target duty. */
    if (period_ns != _rpi_pwm_last_period_ns[ch]) {
        (void)_rpi_pwm_write_str(_rpi_pwm_duty_fd[ch], "0");
        _rpi_pwm_last_duty_ns[ch] = 0;
        snprintf(buf, sizeof(buf), "%llu", (unsigned long long)period_ns);
        if (_rpi_pwm_write_str(_rpi_pwm_period_fd[ch], buf) < 0) { inst->ERR_ID = 3; return; }
        _rpi_pwm_last_period_ns[ch] = period_ns;
    }

    if (duty_ns != _rpi_pwm_last_duty_ns[ch]) {
        snprintf(buf, sizeof(buf), "%llu", (unsigned long long)duty_ns);
        if (_rpi_pwm_write_str(_rpi_pwm_duty_fd[ch], buf) < 0) { inst->ERR_ID = 3; return; }
        _rpi_pwm_last_duty_ns[ch] = duty_ns;
    }

    if (!_rpi_pwm_last_enabled[ch]) {
        if (_rpi_pwm_write_str(_rpi_pwm_enable_fd[ch], "1") < 0) { inst->ERR_ID = 3; return; }
        _rpi_pwm_last_enabled[ch] = 1;
    }

    inst->ACTIVE = true;
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

/* Per-channel device-node overrides: the transpiler emits
 * `#define KRON_I2C<n> "/dev/i2c-<m>"` (from the editor's interface config)
 * before including this header, so logical channel n opens that node instead
 * of the default below. Needed on non-RPi SBCs reusing this HAL whose header
 * I2C bus number differs (Rockchip: often i2c-2/-3/-7; Amlogic/Allwinner vary). */
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

static inline const char *_rpi_i2c_devnode(uint8_t ch, char *buf, size_t n) {
    switch (ch) {
    case 0: return KRON_I2C0;
    case 1: return KRON_I2C1;
    case 2: return KRON_I2C2;
    case 3: return KRON_I2C3;
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

static inline int _rpi_i2c_open(uint8_t ch) {
    if (ch >= 16) return -1;
    if (_rpi_i2c_fd[ch] < 0) {
        char path[24];
        _rpi_i2c_fd[ch] = open(_rpi_i2c_devnode(ch, path, sizeof(path)), O_RDWR);
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

static const char *const _rpi_usb_devs[5] = {
    KRON_USB0, KRON_USB1, KRON_USB2, KRON_USB3, KRON_USB4,
};
static int _rpi_usb_fd[5] = { -1, -1, -1, -1, -1 };

static inline int _rpi_usb_open(uint8_t ch, int32_t baud) {
    if (ch >= 5) return -1;
    if (_rpi_usb_fd[ch] >= 0) return _rpi_usb_fd[ch];

    int fd = open(_rpi_usb_devs[ch], O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    if (tcgetattr(fd, &tty) != 0) { close(fd); return -1; }

    speed_t spd = _rpi_baud_to_speed(baud);
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
     * RPLIDAR A1M8, which interpret DTR-high as motor-off. Linux's default
     * is DTR-high after open(); without this, the motor will spin down a
     * few hundred ms after open() and the data stream stops. */
    int dtr_flag = TIOCM_DTR;
    ioctl(fd, TIOCMBIC, &dtr_flag);

    _rpi_usb_fd[ch] = fd;
    return fd;
}

static inline void HAL_USB_Send_Call(HAL_USB_Send *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _rpi_usb_open(ch, inst->BAUD);
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
    int fd = _rpi_usb_open(ch, inst->BAUD);
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
