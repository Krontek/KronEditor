static inline void {{TYPE_NAME}}_Init({{TYPE_NAME}} *instance, uint8_t port, uint8_t address) {
    instance->_port = port;
    instance->_address = address;
    instance->_clock_hz = {{CLOCK_HZ}};
    instance->_configured = true;
    instance->OK = false;
    instance->ERR_ID = 0;

    uint8_t __cal1[24] = {0};
    uint8_t __cal2[1] = {0};
    uint8_t __cal3[7] = {0};

    if (!HAL_I2C_BurstRead_Port(port, address, 0x88, __cal1, 24, &instance->ERR_ID)) return;
    if (!HAL_I2C_BurstRead_Port(port, address, 0xA1, __cal2, 1, &instance->ERR_ID)) return;
    if (!HAL_I2C_BurstRead_Port(port, address, 0xE1, __cal3, 7, &instance->ERR_ID)) return;

    instance->_dig_T1 = __kron_u16_le(__cal1 + 0);
    instance->_dig_T2 = __kron_s16_le(__cal1 + 2);
    instance->_dig_T3 = __kron_s16_le(__cal1 + 4);
    instance->_dig_P1 = __kron_u16_le(__cal1 + 6);
    instance->_dig_P2 = __kron_s16_le(__cal1 + 8);
    instance->_dig_P3 = __kron_s16_le(__cal1 + 10);
    instance->_dig_P4 = __kron_s16_le(__cal1 + 12);
    instance->_dig_P5 = __kron_s16_le(__cal1 + 14);
    instance->_dig_P6 = __kron_s16_le(__cal1 + 16);
    instance->_dig_P7 = __kron_s16_le(__cal1 + 18);
    instance->_dig_P8 = __kron_s16_le(__cal1 + 20);
    instance->_dig_P9 = __kron_s16_le(__cal1 + 22);
    instance->_dig_H1 = __cal2[0];
    instance->_dig_H2 = __kron_s16_le(__cal3 + 0);
    instance->_dig_H3 = __cal3[2];
    instance->_dig_H4 = (int16_t)(((__cal3[3] << 4) & 0x0FF0) | (__cal3[4] & 0x0F));
    instance->_dig_H5 = (int16_t)(((__cal3[5] << 4) & 0x0FF0) | ((__cal3[4] >> 4) & 0x0F));
    instance->_dig_H6 = (int8_t)__cal3[6];

    {
        const uint8_t __hum[] = { 0x01 };
        const uint8_t __meas[] = { 0x27 };
        const uint8_t __cfg[] = { 0xA0 };
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xF2, __hum, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xF4, __meas, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xF5, __cfg, 1, &instance->ERR_ID)) return;
    }

    instance->OK = true;
}

static inline void {{TYPE_NAME}}_Call({{TYPE_NAME}} *instance) {
    instance->ENO = instance->EN;
    instance->OK = false;
    instance->ERR_ID = 0;
    if (!instance->EN) return;
    if (!instance->_configured) { instance->ERR_ID = 1; return; }

    uint8_t __buf[8] = {0};
    if (!HAL_I2C_BurstRead_Port(instance->_port, instance->_address, 0xF7, __buf, 8, &instance->ERR_ID)) return;

    int32_t adc_P = (int32_t)((((uint32_t)__buf[0]) << 12) | (((uint32_t)__buf[1]) << 4) | (((uint32_t)__buf[2]) >> 4));
    int32_t adc_T = (int32_t)((((uint32_t)__buf[3]) << 12) | (((uint32_t)__buf[4]) << 4) | (((uint32_t)__buf[5]) >> 4));
    int32_t adc_H = (int32_t)((((uint32_t)__buf[6]) << 8) | __buf[7]);

    int32_t var1 = ((((adc_T >> 3) - ((int32_t)instance->_dig_T1 << 1))) * ((int32_t)instance->_dig_T2)) >> 11;
    int32_t var2 = (((((adc_T >> 4) - ((int32_t)instance->_dig_T1)) * ((adc_T >> 4) - ((int32_t)instance->_dig_T1))) >> 12) * ((int32_t)instance->_dig_T3)) >> 14;
    instance->_t_fine = var1 + var2;
    float temperature = (float)((instance->_t_fine * 5 + 128) >> 8) / 100.0f;

    int64_t pvar1 = ((int64_t)instance->_t_fine) - 128000LL;
    int64_t pvar2 = pvar1 * pvar1 * (int64_t)instance->_dig_P6;
    pvar2 = pvar2 + ((pvar1 * (int64_t)instance->_dig_P5) << 17);
    pvar2 = pvar2 + (((int64_t)instance->_dig_P4) << 35);
    pvar1 = ((pvar1 * pvar1 * (int64_t)instance->_dig_P3) >> 8) + ((pvar1 * (int64_t)instance->_dig_P2) << 12);
    pvar1 = (((((int64_t)1) << 47) + pvar1) * ((int64_t)instance->_dig_P1)) >> 33;

    float pressure_hpa = 0.0f;
    if (pvar1 != 0) {
        int64_t p = 1048576LL - adc_P;
        p = (((p << 31) - pvar2) * 3125LL) / pvar1;
        pvar1 = (((int64_t)instance->_dig_P9) * (p >> 13) * (p >> 13)) >> 25;
        pvar2 = (((int64_t)instance->_dig_P8) * p) >> 19;
        p = ((p + pvar1 + pvar2) >> 8) + (((int64_t)instance->_dig_P7) << 4);
        pressure_hpa = (float)p / 25600.0f;
    }

    int32_t h = instance->_t_fine - 76800;
    h = (((((adc_H << 14) - (((int32_t)instance->_dig_H4) << 20) - (((int32_t)instance->_dig_H5) * h)) + 16384) >> 15) *
        (((((((h * ((int32_t)instance->_dig_H6)) >> 10) * (((h * ((int32_t)instance->_dig_H3)) >> 11) + 32768)) >> 10) + 2097152) *
        ((int32_t)instance->_dig_H2) + 8192) >> 14));
    h = h - (((((h >> 15) * (h >> 15)) >> 7) * ((int32_t)instance->_dig_H1)) >> 4);
    if (h < 0) h = 0;
    if (h > 419430400) h = 419430400;
    float humidity = (float)(h >> 12) / 1024.0f;

    instance->{{TEMP_FIELD}} = temperature;
    instance->{{PRESS_FIELD}} = pressure_hpa;
    instance->{{HUM_FIELD}} = humidity;
    instance->OK = true;
}
