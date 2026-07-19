/*
 * kronhal_pico.h  --  Raspberry Pi Pico (RP2040) HAL implementation
 *
 * Targets: rpi_pico, rpi_pico_w
 * Uses the Pico SDK API (hardware/gpio.h, hardware/pwm.h, etc.)
 *
 * NOTE: This is a skeleton -- real Pico SDK calls will be added
 * when cross-compilation for ARM Cortex-M0+ is implemented.
 */
#ifndef KRONHAL_PICO_H
#define KRONHAL_PICO_H

/* Physical header pin (1..40) → RP2040 GPIO number (0..28). -1 = power,
 * ground, RUN, VREF, or otherwise not a GPIO. The pin contract for the
 * PLC block input is "physical header pin", matching the rest of the
 * KronHAL board family. */
static const int8_t _PICO_PHYS_TO_GPIO[41] = {
    /*  0 */ -1,
    /*  1 */  0, /*  2 */  1,   /* GP0            | GP1            */
    /*  3 */ -1, /*  4 */  2,   /* GND            | GP2            */
    /*  5 */  3, /*  6 */  4,   /* GP3            | GP4            */
    /*  7 */  5, /*  8 */ -1,   /* GP5            | GND            */
    /*  9 */  6, /* 10 */  7,   /* GP6            | GP7            */
    /* 11 */  8, /* 12 */  9,   /* GP8            | GP9            */
    /* 13 */ -1, /* 14 */ 10,   /* GND            | GP10           */
    /* 15 */ 11, /* 16 */ 12,   /* GP11           | GP12           */
    /* 17 */ 13, /* 18 */ -1,   /* GP13           | GND            */
    /* 19 */ 14, /* 20 */ 15,   /* GP14           | GP15           */
    /* 21 */ 16, /* 22 */ 17,   /* GP16           | GP17           */
    /* 23 */ -1, /* 24 */ 18,   /* GND            | GP18           */
    /* 25 */ 19, /* 26 */ 20,   /* GP19           | GP20           */
    /* 27 */ 21, /* 28 */ -1,   /* GP21           | GND            */
    /* 29 */ 22, /* 30 */ -1,   /* GP22           | RUN            */
    /* 31 */ 26, /* 32 */ 27,   /* GP26 ADC0      | GP27 ADC1      */
    /* 33 */ -1, /* 34 */ 28,   /* GND/AGND       | GP28 ADC2      */
    /* 35 */ -1, /* 36 */ -1,   /* ADC_VREF       | 3V3 OUT        */
    /* 37 */ -1, /* 38 */ -1,   /* 3V3_EN         | GND            */
    /* 39 */ -1, /* 40 */ -1,   /* VSYS           | VBUS           */
};

static inline int _pico_resolve_phys_pin(int phys) {
    if (phys < 1 || phys > 40) return -1;
    return (int)_PICO_PHYS_TO_GPIO[phys];
}

/* Lifecycle */
static inline void HAL_Init(void)    { /* TODO: stdio_init_all() */ }
static inline void HAL_Cleanup(void) {}

/* GPIO */
static inline void GPIO_Read_Call(GPIO_Read *inst) {
    inst->ENO    = inst->EN;
    inst->VALUE  = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int gp = _pico_resolve_phys_pin((int)inst->PIN);
    if (gp < 0) { inst->ERR_ID = 1; return; }
    /* TODO: inst->VALUE = gpio_get(gp); */
    (void)gp;
}
static inline void GPIO_Write_Call(GPIO_Write *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int gp = _pico_resolve_phys_pin((int)inst->PIN);
    if (gp < 0) { inst->ERR_ID = 1; return; }
    /* TODO: gpio_put(gp, inst->VALUE); */
    (void)gp;
    inst->OK = true;
}
static inline void GPIO_SetMode_Call(GPIO_SetMode *inst) {
    inst->ENO    = inst->EN;
    inst->OK     = false;
    inst->ERR_ID = 0;
    if (!inst->EN) return;
    int gp = _pico_resolve_phys_pin((int)inst->PIN);
    if (gp < 0) { inst->ERR_ID = 1; return; }
    /* TODO: gpio_init(gp); gpio_set_dir(gp, inst->MODE ? GPIO_OUT : GPIO_IN); */
    (void)gp;
    inst->OK = true;
}

/* PWM */
static inline void HAL_PWM_Call(HAL_PWM *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: pwm_set_wrap / pwm_set_chan_level */
    inst->ACTIVE = inst->EN;
}

/* SPI */
static inline void HAL_SPI_Call(HAL_SPI *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: spi_write_read_blocking */
    inst->RX_DATA = 0;
    inst->DONE = inst->EN;
}

/* I2C */
static inline void HAL_I2C_Read_Call(HAL_I2C_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: i2c_read_blocking */
    inst->DATA = 0;
    inst->OK = inst->EN;
}
static inline void HAL_I2C_Write_Call(HAL_I2C_Write *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: i2c_write_blocking */
    inst->OK = inst->EN;
}

/* UART */
static inline void HAL_UART_Send_Call(HAL_UART_Send *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: uart_putc_raw */
    inst->DONE = inst->EN;
}
static inline void HAL_UART_Receive_Call(HAL_UART_Receive *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    inst->DATA = 0;
    inst->READY = false;
}

/* ADC */
static inline void HAL_ADC_Read_Call(HAL_ADC_Read *inst, uint8_t ch) {
    (void)ch;
    inst->ENO = inst->EN;
    /* TODO: adc_select_input(ch); adc_read() */
    inst->VALUE = 0;
    inst->VOLTAGE = 0.0f;
}

/* CAN -- not available on Pico */
static inline void HAL_CAN_Send_Call(HAL_CAN_Send *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->DONE = false;
}
static inline void HAL_CAN_Receive_Call(HAL_CAN_Receive *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->READY = false;
}

/* PRU -- not available on Pico */
static inline void HAL_PRU_Execute_Call(HAL_PRU_Execute *inst, uint8_t ch) {
    (void)ch; inst->ENO = inst->EN; inst->RESULT = 0; inst->DONE = false;
}

/* PCM -- not available on Pico */
static inline void PCM_Output_Call(PCM_Output *inst) {
    inst->ENO = inst->EN; inst->OK = false;
}
static inline void PCM_Input_Call(PCM_Input *inst) {
    inst->ENO = inst->EN; inst->DATA = 0; inst->READY = false;
}

/* Grove -- not natively available on Pico */
static inline void Grove_DigitalRead_Call(Grove_DigitalRead *inst) {
    inst->ENO = inst->EN; inst->VALUE = false;
}
static inline void Grove_DigitalWrite_Call(Grove_DigitalWrite *inst) {
    inst->ENO = inst->EN; inst->OK = false;
}
static inline void Grove_AnalogRead_Call(Grove_AnalogRead *inst) {
    inst->ENO = inst->EN; inst->VALUE = 0; inst->VOLTAGE = 0.0f;
}

#endif /* KRONHAL_PICO_H */
