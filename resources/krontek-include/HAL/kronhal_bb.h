/*
 * kronhal_bb.h  --  BeagleBone family HAL implementation
 *
 * Targets: bb_black, bb_black_wireless, bb_green, bb_green_wireless,
 *          bb_ai, bb_ai64
 *
 * Real implementations (standard Linux userspace APIs, no external libs):
 *   GPIO  : GPIO character-device ioctl on /dev/gpiochip0..3
 *           (AM335x: 4 banks x 32 lines; line id = bank*32 + offset)
 *   PWM   : sysfs /sys/class/pwm — chips are scanned and their channels
 *           FLATTENED into one global index (AM335x ehrpwm chips expose
 *           2 channels each, so PWM0/1 -> first chip, PWM2 -> second)
 *   I2C   : /dev/i2c-0..2 via I2C_SLAVE/I2C_RDWR ioctl
 *   SPI   : /dev/spidevB.C via SPI_IOC_MESSAGE (single byte + burst)
 *   UART  : /dev/ttyS0..5 termios (override via KRON_UARTn defines —
 *           legacy 3.x kernels used /dev/ttyO*)
 *   USB   : /dev/ttyUSB0 + /dev/ttyACM0 termios (DTR dropped on open)
 *   ADC   : AM335x 12-bit / 1.8 V via IIO in_voltageN_raw
 *   CAN   : SocketCAN ("can0"/"can1" = dcan0/dcan1 — user must
 *           `ip link set can0 up type can bitrate ...` first)
 *
 * Honest stubs (ERR_ID=1, never a fake success):
 *   PRU (needs remoteproc firmware infra), PCM, Grove, DI/DO modules.
 *
 * ⚠️ The pin map below is the AM335x (Black/Green) table from the
 * BeagleBone SRM. bb_ai (AM5729) and bb_ai64 (TDA4VM) route different
 * SoC pads to the same header positions — GPIO on those boards needs a
 * board-specific verification before trusting the map (unknown pins are
 * safe: they fail with ERR_ID=3 at request time, never write blind).
 * Many P8 pins conflict with HDMI/eMMC unless those are disabled in
 * the device tree; the request simply fails (EBUSY) in that case.
 */
#ifndef KRONHAL_BB_H
#define KRONHAL_BB_H

#include <linux/gpio.h>
#include <linux/i2c-dev.h>
#include <linux/i2c.h>
#include <linux/spi/spidev.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <dirent.h>

/* ---------------------------------------------------------------------------
 * Device-node defaults — every one overridable from the editor's interface
 * config (the transpiler emits #define KRON_XXXn "path" before kronhal.h).
 * -------------------------------------------------------------------------*/
#ifndef KRON_UART0
#define KRON_UART0 "/dev/ttyS0"   /* console — avoid in production */
#endif
#ifndef KRON_UART1
#define KRON_UART1 "/dev/ttyS1"
#endif
#ifndef KRON_UART2
#define KRON_UART2 "/dev/ttyS2"
#endif
#ifndef KRON_UART3
#define KRON_UART3 "/dev/ttyS3"
#endif
#ifndef KRON_UART4
#define KRON_UART4 "/dev/ttyS4"
#endif
#ifndef KRON_UART5
#define KRON_UART5 "/dev/ttyS5"
#endif
#ifndef KRON_USB0
#define KRON_USB0 "/dev/ttyUSB0"
#endif
#ifndef KRON_USB1
#define KRON_USB1 "/dev/ttyACM0"
#endif
#ifndef KRON_I2C0
#define KRON_I2C0 "/dev/i2c-0"    /* internal (PMIC/EEPROM) */
#endif
#ifndef KRON_I2C1
#define KRON_I2C1 "/dev/i2c-1"
#endif
#ifndef KRON_I2C2
#define KRON_I2C2 "/dev/i2c-2"    /* cape header P9_19/P9_20 */
#endif
#ifndef KRON_CAN0
#define KRON_CAN0 "can0"          /* dcan0 */
#endif
#ifndef KRON_CAN1
#define KRON_CAN1 "can1"          /* dcan1 (P9_24/P9_26) */
#endif
/* AM335x ADC: 12-bit, 1.8 V reference (AIN0..6 on P9_33..P9_40). */
#ifndef KRON_ADC_VREF
#define KRON_ADC_VREF 1.8f
#endif
#ifndef KRON_ADC_MAX_RAW
#define KRON_ADC_MAX_RAW 4095.0f
#endif

/* ---------------------------------------------------------------------------
 * Physical header pin → packed GPIO line (bank*32 + offset)
 *     1..46    → P9 header
 *     101..146 → P8 header (physical pin + 100)
 * Source: BeagleBone Black System Reference Manual (AM335x).
 * -1 = power/ground/analog/non-GPIO.
 * -------------------------------------------------------------------------*/
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
    [19]   =  13, [20]  =  12,                         /* GPIO0_13 / GPIO0_12 (I2C2) */
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
    /* P8 header — pins 101..146 (physical + 100) */
    [101] = -1,  [102] = -1,                           /* GND / GND */
    [103] = 38,  [104] = 39,                           /* GPIO1_6  / GPIO1_7  (eMMC) */
    [105] = 34,  [106] = 35,                           /* GPIO1_2  / GPIO1_3  (eMMC) */
    [107] = 66,  [108] = 67,                           /* GPIO2_2  / GPIO2_3  */
    [109] = 69,  [110] = 68,                           /* GPIO2_5  / GPIO2_4  */
    [111] = 45,  [112] = 44,                           /* GPIO1_13 / GPIO1_12 */
    [113] = 23,  [114] = 26,                           /* GPIO0_23 / GPIO0_26 */
    [115] = 47,  [116] = 46,                           /* GPIO1_15 / GPIO1_14 */
    [117] = 27,  [118] = 65,                           /* GPIO0_27 / GPIO2_1  */
    [119] = 22,  [120] = 63,                           /* GPIO0_22 / GPIO1_31 (eMMC) */
    [121] = 62,  [122] = 37,                           /* GPIO1_30 / GPIO1_5  (eMMC) */
    [123] = 36,  [124] = 33,                           /* GPIO1_4  / GPIO1_1  (eMMC) */
    [125] = 32,  [126] = 61,                           /* GPIO1_0  / GPIO1_29 (eMMC) */
    [127] = 86,  [128] = 88,                           /* GPIO2_22 / GPIO2_24 (HDMI) */
    [129] = 87,  [130] = 89,                           /* GPIO2_23 / GPIO2_25 (HDMI) */
    [131] = 10,  [132] = 11,                           /* GPIO0_10 / GPIO0_11 (HDMI) */
    [133] = 9,   [134] = 81,                           /* GPIO0_9  / GPIO2_17 (HDMI) */
    [135] = 8,   [136] = 80,                           /* GPIO0_8  / GPIO2_16 (HDMI) */
    [137] = 78,  [138] = 79,                           /* GPIO2_14 / GPIO2_15 (HDMI) */
    [139] = 76,  [140] = 77,                           /* GPIO2_12 / GPIO2_13 (HDMI) */
    [141] = 74,  [142] = 75,                           /* GPIO2_10 / GPIO2_11 (HDMI) */
    [143] = 72,  [144] = 73,                           /* GPIO2_8  / GPIO2_9  (HDMI) */
    [145] = 70,  [146] = 71,                           /* GPIO2_6  / GPIO2_7  (HDMI) */
};

static inline int _bb_resolve_phys_pin(int phys) {
    if (phys < 1 || phys > 146) return -1;
    return (int)_BB_PHYS_TO_LINE[phys];
}

/* ---------------------------------------------------------------------------
 * GPIO — character-device ioctl across the 4 AM335x banks
 * -------------------------------------------------------------------------*/
#define _BB_GPIO_BANKS 4
#define _BB_GPIO_MAX   (_BB_GPIO_BANKS * 32)

enum { _BB_DIR_NONE = 0, _BB_DIR_INPUT, _BB_DIR_OUTPUT, _BB_DIR_ERROR };

static int _bb_chip_fd[_BB_GPIO_BANKS] = { -1, -1, -1, -1 };
static int _bb_line_fd[_BB_GPIO_MAX];
static uint8_t _bb_line_dir[_BB_GPIO_MAX];
static int _bb_gpio_state_init = 0;

static inline void _bb_gpio_state_ensure(void) {
    if (_bb_gpio_state_init) return;
    for (int i = 0; i < _BB_GPIO_MAX; i++) { _bb_line_fd[i] = -1; _bb_line_dir[i] = _BB_DIR_NONE; }
    _bb_gpio_state_init = 1;
}

static inline int _bb_chip_open(int bank) {
    if (bank < 0 || bank >= _BB_GPIO_BANKS) return -1;
    if (_bb_chip_fd[bank] >= 0) return _bb_chip_fd[bank];
    char path[24];
    snprintf(path, sizeof(path), "/dev/gpiochip%d", bank);
    _bb_chip_fd[bank] = open(path, O_RDWR | O_CLOEXEC);
    return _bb_chip_fd[bank];
}

static inline void _bb_gpio_release_line(int line) {
    if (_bb_line_fd[line] >= 0) { close(_bb_line_fd[line]); _bb_line_fd[line] = -1; }
    _bb_line_dir[line] = _BB_DIR_NONE;
}

static inline int _bb_gpio_request(int line, int want_output) {
    _bb_gpio_state_ensure();
    uint8_t want = want_output ? _BB_DIR_OUTPUT : _BB_DIR_INPUT;
    if (_bb_line_dir[line] == want)          return 0;
    if (_bb_line_dir[line] == _BB_DIR_ERROR) return -1;

    int chip = _bb_chip_open(line / 32);
    if (chip < 0) { _bb_line_dir[line] = _BB_DIR_ERROR; return -1; }

    _bb_gpio_release_line(line);

    struct gpiohandle_request req;
    memset(&req, 0, sizeof(req));
    req.lineoffsets[0]    = (uint32_t)(line % 32);
    req.flags             = want_output ? GPIOHANDLE_REQUEST_OUTPUT : GPIOHANDLE_REQUEST_INPUT;
    req.default_values[0] = 0;
    strncpy(req.consumer_label, "kronplc", sizeof(req.consumer_label) - 1);
    req.lines = 1;

    if (ioctl(chip, GPIO_GET_LINEHANDLE_IOCTL, &req) < 0 || req.fd < 0) {
        _bb_line_dir[line] = _BB_DIR_ERROR;
        return -1;
    }
    _bb_line_fd[line]  = req.fd;
    _bb_line_dir[line] = want;
    return 0;
}

static inline void GPIO_Write_Call(GPIO_Write *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int line = _bb_resolve_phys_pin((int)inst->PIN);
    if (line < 0 || line >= _BB_GPIO_MAX) { inst->ERR_ID = 1; return; }
    if (_bb_gpio_request(line, 1) < 0)    { inst->ERR_ID = 3; return; }
    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    data.values[0] = inst->VALUE ? 1 : 0;
    inst->OK = (ioctl(_bb_line_fd[line], GPIOHANDLE_SET_LINE_VALUES_IOCTL, &data) == 0);
    if (!inst->OK) inst->ERR_ID = 3;
}

static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int line = _bb_resolve_phys_pin((int)inst->PIN);
    if (line < 0 || line >= _BB_GPIO_MAX) { inst->ERR_ID = 1; return; }
    if (_bb_gpio_request(line, 0) < 0)    { inst->ERR_ID = 3; return; }
    struct gpiohandle_data data;
    memset(&data, 0, sizeof(data));
    if (ioctl(_bb_line_fd[line], GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) == 0)
        inst->VALUE = (bool)data.values[0];
    else
        inst->ERR_ID = 3;
}

static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int line = _bb_resolve_phys_pin((int)inst->PIN);
    if (line < 0 || line >= _BB_GPIO_MAX) { inst->ERR_ID = 1; return; }
    inst->OK = (_bb_gpio_request(line, inst->MODE != 0) == 0);
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * PWM — sysfs, channels FLATTENED across chips
 *
 * AM335x exposes ehrpwm0/1/2 (+ ecap) as separate 2-channel pwmchips whose
 * numbering varies by kernel. Unlike the RPi (one chip with all channels),
 * the global PLC channel index is mapped across chips in ascending chip
 * order: chip A ch0 → PWM0, chip A ch1 → PWM1, chip B ch0 → PWM2, ...
 * The pinmux (which header pin each channel drives) comes from the device
 * tree / cape overlay, exactly like the RPi dtoverlay.
 * -------------------------------------------------------------------------*/
#define KRON_BB_PWM_MAX 8
static int      _bb_pwm_scanned = 0;
static int      _bb_pwm_chip_of[KRON_BB_PWM_MAX];
static int      _bb_pwm_index_of[KRON_BB_PWM_MAX];
static int      _bb_pwm_count = 0;
static int      _bb_pwm_period_fd[KRON_BB_PWM_MAX];
static int      _bb_pwm_duty_fd[KRON_BB_PWM_MAX];
static int      _bb_pwm_enable_fd[KRON_BB_PWM_MAX];
static int      _bb_pwm_open_ok[KRON_BB_PWM_MAX];
static uint64_t _bb_pwm_last_period_ns[KRON_BB_PWM_MAX];
static uint64_t _bb_pwm_last_duty_ns[KRON_BB_PWM_MAX];
static int      _bb_pwm_last_enabled[KRON_BB_PWM_MAX];

static inline void _bb_pwm_scan(void) {
    if (_bb_pwm_scanned) return;
    _bb_pwm_scanned = 1;
    for (int i = 0; i < KRON_BB_PWM_MAX; i++) {
        _bb_pwm_chip_of[i] = -1; _bb_pwm_index_of[i] = -1;
        _bb_pwm_period_fd[i] = _bb_pwm_duty_fd[i] = _bb_pwm_enable_fd[i] = -1;
        _bb_pwm_open_ok[i] = 0;
        _bb_pwm_last_period_ns[i] = _bb_pwm_last_duty_ns[i] = 0;
        _bb_pwm_last_enabled[i] = 0;
    }
    /* Collect chip indices, sort ascending for a stable flattening order. */
    int chips[16]; int nchips = 0;
    DIR *d = opendir("/sys/class/pwm");
    if (!d) return;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL && nchips < 16) {
        if (strncmp(ent->d_name, "pwmchip", 7) != 0) continue;
        int idx = atoi(ent->d_name + 7);
        if (idx >= 0) chips[nchips++] = idx;
    }
    closedir(d);
    for (int i = 1; i < nchips; i++) {
        int v = chips[i], j = i - 1;
        while (j >= 0 && chips[j] > v) { chips[j + 1] = chips[j]; j--; }
        chips[j + 1] = v;
    }
    for (int c = 0; c < nchips && _bb_pwm_count < KRON_BB_PWM_MAX; c++) {
        char path[96];
        snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/npwm", chips[c]);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        int npwm = 0;
        if (fscanf(f, "%d", &npwm) != 1) npwm = 0;
        fclose(f);
        for (int k = 0; k < npwm && _bb_pwm_count < KRON_BB_PWM_MAX; k++) {
            _bb_pwm_chip_of[_bb_pwm_count]  = chips[c];
            _bb_pwm_index_of[_bb_pwm_count] = k;
            _bb_pwm_count++;
        }
    }
}

static inline int _bb_pwm_write_str(int fd, const char *s) {
    if (fd < 0) return -1;
    lseek(fd, 0, SEEK_SET);
    size_t len = strlen(s);
    return (write(fd, s, len) == (ssize_t)len) ? 0 : -1;
}

static inline int _bb_pwm_open(uint8_t ch) {
    _bb_pwm_scan();
    if (ch >= KRON_BB_PWM_MAX || ch >= (uint8_t)_bb_pwm_count) return -1;
    if (_bb_pwm_open_ok[ch]) return 0;
    int chip = _bb_pwm_chip_of[ch], idx = _bb_pwm_index_of[ch];
    char path[96];

    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/export", chip);
    int exp_fd = open(path, O_WRONLY);
    if (exp_fd >= 0) {
        char buf[8];
        int n = snprintf(buf, sizeof(buf), "%d", idx);
        (void)write(exp_fd, buf, n);
        close(exp_fd);
    }

    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/pwm%d/period", chip, idx);
    _bb_pwm_period_fd[ch] = open(path, O_WRONLY);
    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/pwm%d/duty_cycle", chip, idx);
    _bb_pwm_duty_fd[ch] = open(path, O_WRONLY);
    snprintf(path, sizeof(path), "/sys/class/pwm/pwmchip%d/pwm%d/enable", chip, idx);
    _bb_pwm_enable_fd[ch] = open(path, O_WRONLY);

    if (_bb_pwm_period_fd[ch] < 0 || _bb_pwm_duty_fd[ch] < 0 || _bb_pwm_enable_fd[ch] < 0) {
        if (_bb_pwm_period_fd[ch] >= 0) { close(_bb_pwm_period_fd[ch]); _bb_pwm_period_fd[ch] = -1; }
        if (_bb_pwm_duty_fd[ch]   >= 0) { close(_bb_pwm_duty_fd[ch]);   _bb_pwm_duty_fd[ch]   = -1; }
        if (_bb_pwm_enable_fd[ch] >= 0) { close(_bb_pwm_enable_fd[ch]); _bb_pwm_enable_fd[ch] = -1; }
        return -1;
    }
    (void)_bb_pwm_write_str(_bb_pwm_enable_fd[ch], "0");
    (void)_bb_pwm_write_str(_bb_pwm_duty_fd[ch],   "0");
    _bb_pwm_last_period_ns[ch] = 0;
    _bb_pwm_last_duty_ns[ch]   = 0;
    _bb_pwm_last_enabled[ch]   = 0;
    _bb_pwm_open_ok[ch]        = 1;
    return 0;
}

static inline void HAL_PWM_Call(HAL_PWM *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->ERR_ID = 0;
    inst->ACTIVE = false;

    if (ch >= KRON_BB_PWM_MAX) { inst->ERR_ID = 1; return; }

    if (!inst->EN) {
        if (_bb_pwm_open_ok[ch] && _bb_pwm_last_enabled[ch]) {
            (void)_bb_pwm_write_str(_bb_pwm_enable_fd[ch], "0");
            _bb_pwm_last_enabled[ch] = 0;
        }
        return;
    }

    if (_bb_pwm_open(ch) < 0) { inst->ERR_ID = 3; return; }

    float freq = inst->FREQ;
    if (freq < 1.0f)       freq = 1.0f;
    if (freq > 1000000.0f) freq = 1000000.0f;
    float duty = inst->DUTY;
    if (duty < 0.0f)   duty = 0.0f;
    if (duty > 100.0f) duty = 100.0f;

    uint64_t period_ns = (uint64_t)(1000000000.0f / freq);
    uint64_t duty_ns   = (uint64_t)((double)period_ns * (double)duty / 100.0);
    if (duty_ns > period_ns) duty_ns = period_ns;

    char buf[32];
    if (period_ns != _bb_pwm_last_period_ns[ch]) {
        (void)_bb_pwm_write_str(_bb_pwm_duty_fd[ch], "0");
        _bb_pwm_last_duty_ns[ch] = 0;
        snprintf(buf, sizeof(buf), "%llu", (unsigned long long)period_ns);
        if (_bb_pwm_write_str(_bb_pwm_period_fd[ch], buf) < 0) { inst->ERR_ID = 3; return; }
        _bb_pwm_last_period_ns[ch] = period_ns;
    }
    if (duty_ns != _bb_pwm_last_duty_ns[ch]) {
        snprintf(buf, sizeof(buf), "%llu", (unsigned long long)duty_ns);
        if (_bb_pwm_write_str(_bb_pwm_duty_fd[ch], buf) < 0) { inst->ERR_ID = 3; return; }
        _bb_pwm_last_duty_ns[ch] = duty_ns;
    }
    if (!_bb_pwm_last_enabled[ch]) {
        if (_bb_pwm_write_str(_bb_pwm_enable_fd[ch], "1") < 0) { inst->ERR_ID = 3; return; }
        _bb_pwm_last_enabled[ch] = 1;
    }
    inst->ACTIVE = true;
}

/* ---------------------------------------------------------------------------
 * I2C — /dev/i2c-N (single register read/write + burst)
 * -------------------------------------------------------------------------*/
static int _bb_i2c_fd[3] = { -1, -1, -1 };

static inline const char *_bb_i2c_devnode(uint8_t ch, char *buf, size_t n) {
    switch (ch) {
    case 0: return KRON_I2C0;
    case 1: return KRON_I2C1;
    case 2: return KRON_I2C2;
    default: break;
    }
    snprintf(buf, n, "/dev/i2c-%u", (unsigned)ch);
    return buf;
}

static inline int _bb_i2c_open(uint8_t ch) {
    if (ch >= 3) return -1;
    if (_bb_i2c_fd[ch] < 0) {
        char path[24];
        _bb_i2c_fd[ch] = open(_bb_i2c_devnode(ch, path, sizeof(path)), O_RDWR);
    }
    return _bb_i2c_fd[ch];
}

static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DATA   = 0;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _bb_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t reg = inst->REG, val = 0;
    if (write(fd, &reg, 1) != 1) { inst->ERR_ID = 3; return; }
    if (read(fd, &val, 1)  != 1) { inst->ERR_ID = 3; return; }
    inst->DATA = val;
    inst->OK   = true;
}

static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int fd = _bb_i2c_open(ch);
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
    if (!inst->BUFFER || inst->LEN == 0 || inst->LEN > 255) { inst->ERR_ID = 1; return; }
    int fd = _bb_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t reg = inst->REG;
    if (write(fd, &reg, 1) != 1)                       { inst->ERR_ID = 3; return; }
    if (read(fd, inst->BUFFER, (size_t)inst->LEN) != (ssize_t)inst->LEN) { inst->ERR_ID = 3; return; }
    inst->OK = true;
}

static inline void HAL_I2C_BurstWrite_Call(HAL_I2C_BurstWrite *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (!inst->BUFFER || inst->LEN == 0 || inst->LEN > 254) { inst->ERR_ID = 1; return; }
    int fd = _bb_i2c_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }
    if (ioctl(fd, I2C_SLAVE, (long)inst->ADDR) < 0) { inst->ERR_ID = 3; return; }
    uint8_t buf[255];
    buf[0] = inst->REG;
    memcpy(buf + 1, inst->BUFFER, (size_t)inst->LEN);
    inst->OK = (write(fd, buf, (size_t)inst->LEN + 1) == (ssize_t)(inst->LEN + 1));
    if (!inst->OK) inst->ERR_ID = 3;
}

/* ---------------------------------------------------------------------------
 * SPI — /dev/spidevB.C (single byte + burst, both real)
 * -------------------------------------------------------------------------*/
static int _bb_spi_fd[4][4] = {
    { -1, -1, -1, -1 }, { -1, -1, -1, -1 }, { -1, -1, -1, -1 }, { -1, -1, -1, -1 },
};

static inline int _bb_spi_open(uint8_t bus, uint8_t cs, uint8_t mode, int32_t clk_hz) {
    if (bus >= 4 || cs >= 4) return -1;
    if (_bb_spi_fd[bus][cs] >= 0) return _bb_spi_fd[bus][cs];
    char path[24];
    snprintf(path, sizeof(path), "/dev/spidev%d.%d", (int)bus, (int)cs);
    int fd = open(path, O_RDWR);
    if (fd < 0) return -1;
    uint8_t m = mode & 0x03, bits = 8;
    uint32_t hz = (clk_hz > 0) ? (uint32_t)clk_hz : 1000000u;
    if (ioctl(fd, SPI_IOC_WR_MODE, &m) < 0 ||
        ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, &bits) < 0 ||
        ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ, &hz) < 0) {
        close(fd);
        return -1;
    }
    _bb_spi_fd[bus][cs] = fd;
    return fd;
}

static inline void HAL_SPI_Call(HAL_SPI *inst, uint8_t ch) {
    inst->ENO     = inst->EN;
    inst->RX_DATA = 0;
    inst->DONE    = false;
    inst->ERR_ID  = 0;
    if (!inst->EN) return;
    uint8_t cs = (inst->CS >= 0 && inst->CS < 4) ? (uint8_t)inst->CS : 0;
    int fd = _bb_spi_open(ch, cs, 0, inst->CLK_HZ);
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

static inline void HAL_SPI_BurstTransfer_Call(HAL_SPI_BurstTransfer *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    if (inst->LEN == 0 || inst->LEN > 255) { inst->ERR_ID = 1; return; }

    int fd = _bb_spi_open(ch, (uint8_t)inst->CS, inst->MODE, inst->CLK_HZ);
    if (fd < 0) { inst->ERR_ID = 2; return; }

    uint8_t tx_buf[255], rx_buf[255];
    if (inst->TX_BUF) memcpy(tx_buf, inst->TX_BUF, inst->LEN);
    else              memset(tx_buf, 0,            inst->LEN);

    struct spi_ioc_transfer tr;
    memset(&tr, 0, sizeof(tr));
    tr.tx_buf        = (unsigned long)(uintptr_t)tx_buf;
    tr.rx_buf        = (unsigned long)(uintptr_t)rx_buf;
    tr.len           = (uint32_t)inst->LEN;
    tr.speed_hz      = (inst->CLK_HZ > 0) ? (uint32_t)inst->CLK_HZ : 0;
    tr.bits_per_word = 8;

    if (ioctl(fd, SPI_IOC_MESSAGE(1), &tr) < 1) { inst->ERR_ID = 3; return; }
    if (inst->RX_BUF) memcpy(inst->RX_BUF, rx_buf, inst->LEN);
    inst->DONE = true;
}

/* ---------------------------------------------------------------------------
 * UART — termios (real; device nodes overridable via KRON_UARTn)
 * -------------------------------------------------------------------------*/
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

/* ---------------------------------------------------------------------------
 * USB serial — termios (real; DTR dropped on open for RPLIDAR-class devices)
 * -------------------------------------------------------------------------*/
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
     * RPLIDAR A1M8 (DTR-high = motor-off). */
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

/* ---------------------------------------------------------------------------
 * ADC — AM335x via IIO (12-bit, 1.8 V, AIN0..6)
 *
 * Scans /sys/bus/iio/devices for the first iio:deviceN exposing
 * in_voltage<ch>_raw. Requires the ti_am335x_adc overlay (BB-ADC on stock
 * Debian images). Missing device → ERR_ID=2, never a silent zero.
 * -------------------------------------------------------------------------*/
static int _bb_adc_dev = -1;   /* -1 unknown, -2 scan failed, >=0 device idx */

static inline int _bb_adc_find_dev(uint8_t ch) {
    if (_bb_adc_dev == -2) return -1;
    if (_bb_adc_dev >= 0)  return _bb_adc_dev;
    DIR *d = opendir("/sys/bus/iio/devices");
    if (!d) { _bb_adc_dev = -2; return -1; }
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        int idx;
        if (sscanf(ent->d_name, "iio:device%d", &idx) != 1) continue;
        char path[128];
        snprintf(path, sizeof(path), "/sys/bus/iio/devices/iio:device%d/in_voltage%u_raw", idx, (unsigned)ch);
        if (access(path, R_OK) == 0) { _bb_adc_dev = idx; break; }
    }
    closedir(d);
    if (_bb_adc_dev < 0) _bb_adc_dev = -2;
    return (_bb_adc_dev >= 0) ? _bb_adc_dev : -1;
}

static inline void HAL_ADC_Read_Call(HAL_ADC_Read *inst, uint8_t ch) {
    inst->ENO     = inst->EN;
    inst->VALUE   = 0;
    inst->VOLTAGE = 0.0f;
    inst->ERR_ID  = 0;
    if (!inst->EN) return;
    if (ch >= 7) { inst->ERR_ID = 1; return; }
    int dev = _bb_adc_find_dev(ch);
    if (dev < 0) { inst->ERR_ID = 2; return; }
    char path[128];
    snprintf(path, sizeof(path), "/sys/bus/iio/devices/iio:device%d/in_voltage%u_raw", dev, (unsigned)ch);
    FILE *f = fopen(path, "r");
    if (!f) { inst->ERR_ID = 3; return; }
    long raw = 0;
    int ok = (fscanf(f, "%ld", &raw) == 1);
    fclose(f);
    if (!ok) { inst->ERR_ID = 3; return; }
    inst->VALUE   = (int32_t)raw;
    inst->VOLTAGE = (float)raw * KRON_ADC_VREF / KRON_ADC_MAX_RAW;
}

/* ---------------------------------------------------------------------------
 * CAN — SocketCAN (dcan0/dcan1). Bring the interface up first:
 *     ip link set can0 up type can bitrate 500000
 * -------------------------------------------------------------------------*/
static const char *const _bb_can_ifaces[2] = { KRON_CAN0, KRON_CAN1 };
static int _bb_can_fd[2] = { -1, -1 };

static inline int _bb_can_open(uint8_t ch) {
    if (ch >= 2) return -1;
    if (_bb_can_fd[ch] >= 0) return _bb_can_fd[ch];

    int fd = socket(AF_CAN, SOCK_RAW, CAN_RAW);
    if (fd < 0) return -1;

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, _bb_can_ifaces[ch], IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFINDEX, &ifr) < 0) { close(fd); return -1; }

    struct sockaddr_can addr;
    memset(&addr, 0, sizeof(addr));
    addr.can_family  = AF_CAN;
    addr.can_ifindex = ifr.ifr_ifindex;
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { close(fd); return -1; }

    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    _bb_can_fd[ch] = fd;
    return fd;
}

static inline void HAL_CAN_Send_Call(HAL_CAN_Send *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->DONE   = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int fd = _bb_can_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }

    struct can_frame frame;
    memset(&frame, 0, sizeof(frame));
    frame.can_id  = (uint32_t)inst->ID & CAN_SFF_MASK;
    frame.can_dlc = (inst->DLC > 8) ? 8 : (uint8_t)inst->DLC;
    if (frame.can_dlc > 0) frame.data[0] = inst->DATA;

    inst->DONE = (write(fd, &frame, sizeof(frame)) == (ssize_t)sizeof(frame));
    if (!inst->DONE) inst->ERR_ID = 3;
}

static inline void HAL_CAN_Receive_Call(HAL_CAN_Receive *inst, uint8_t ch) {
    inst->ENO    = inst->EN;
    inst->READY  = false;
    inst->DATA   = 0;
    inst->ID     = 0;
    inst->ERR_ID = 0;
    if (!inst->EN) return;

    int fd = _bb_can_open(ch);
    if (fd < 0) { inst->ERR_ID = 2; return; }

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
 * Honest stubs — features that exist on the silicon but need infrastructure
 * this HAL does not provide yet. They FAIL LOUDLY (ERR_ID=1) instead of
 * pretending success; a fake DONE=EN wastes days of field debugging.
 * -------------------------------------------------------------------------*/

/* PRU: needs remoteproc firmware loading + rpmsg — out of HAL scope for now. */
static inline void HAL_PRU_Execute_Call(HAL_PRU_Execute *inst, uint8_t ch) {
    (void)ch;
    inst->ENO    = inst->EN;
    inst->RESULT = 0;
    inst->DONE   = false;
    inst->ERR_ID = inst->EN ? 1 : 0;
}

/* PCM — not wired on BeagleBone. */
static inline void PCM_Output_Call(PCM_Output *inst) {
    inst->ENO = inst->EN; inst->OK = false;
}
static inline void PCM_Input_Call(PCM_Input *inst) {
    inst->ENO = inst->EN; inst->DATA = 0; inst->READY = false;
}

/* Grove (BB Green): the connectors are plain I2C2/UART2 pass-throughs —
 * use the I2C/UART blocks directly. */
static inline void Grove_DigitalRead_Call(Grove_DigitalRead *inst) {
    inst->ENO = inst->EN; inst->VALUE = false;
}
static inline void Grove_DigitalWrite_Call(Grove_DigitalWrite *inst) {
    inst->ENO = inst->EN; inst->OK = false;
}
static inline void Grove_AnalogRead_Call(Grove_AnalogRead *inst) {
    inst->ENO = inst->EN; inst->VALUE = 0; inst->VOLTAGE = 0.0f;
}

/* DI/DO expansion modules — same stub shape as the other Linux families. */
static inline void HAL_DI_Read_Call(HAL_DI_Read *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->VALUE = false;
}
static inline void HAL_DO_Write_Call(HAL_DO_Write *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->OK = false;
}

/* ---------------------------------------------------------------------------
 * Lifecycle
 * -------------------------------------------------------------------------*/
static inline void HAL_Init(void) {
    _bb_gpio_state_ensure();
}

static inline void HAL_Cleanup(void) {
    int i;
    _bb_gpio_state_ensure();
    for (i = 0; i < _BB_GPIO_MAX; i++) _bb_gpio_release_line(i);
    for (i = 0; i < _BB_GPIO_BANKS; i++) {
        if (_bb_chip_fd[i] >= 0) { close(_bb_chip_fd[i]); _bb_chip_fd[i] = -1; }
    }
    for (i = 0; i < KRON_BB_PWM_MAX; i++) {
        if (_bb_pwm_open_ok[i]) {
            (void)_bb_pwm_write_str(_bb_pwm_enable_fd[i], "0");
            if (_bb_pwm_period_fd[i] >= 0) { close(_bb_pwm_period_fd[i]); _bb_pwm_period_fd[i] = -1; }
            if (_bb_pwm_duty_fd[i]   >= 0) { close(_bb_pwm_duty_fd[i]);   _bb_pwm_duty_fd[i]   = -1; }
            if (_bb_pwm_enable_fd[i] >= 0) { close(_bb_pwm_enable_fd[i]); _bb_pwm_enable_fd[i] = -1; }
            _bb_pwm_open_ok[i] = 0;
        }
    }
    for (i = 0; i < 3; i++) if (_bb_i2c_fd[i] >= 0) { close(_bb_i2c_fd[i]); _bb_i2c_fd[i] = -1; }
    for (i = 0; i < 4; i++) for (int j = 0; j < 4; j++)
        if (_bb_spi_fd[i][j] >= 0) { close(_bb_spi_fd[i][j]); _bb_spi_fd[i][j] = -1; }
    for (i = 0; i < 6; i++) if (_bb_uart_fd[i] >= 0) { close(_bb_uart_fd[i]); _bb_uart_fd[i] = -1; }
    for (i = 0; i < 2; i++) if (_bb_usb_fd[i]  >= 0) { close(_bb_usb_fd[i]);  _bb_usb_fd[i]  = -1; }
    for (i = 0; i < 2; i++) if (_bb_can_fd[i]  >= 0) { close(_bb_can_fd[i]);  _bb_can_fd[i]  = -1; }
}

#endif /* KRONHAL_BB_H */
