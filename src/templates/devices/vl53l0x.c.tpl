static inline void {{TYPE_NAME}}_Init({{TYPE_NAME}} *instance, uint8_t port, uint8_t address) {
    instance->_port = port;
    instance->_address = address;
    instance->_clock_hz = {{CLOCK_HZ}};
    instance->_configured = true;
    instance->OK = false;
    instance->ERR_ID = 0;

    {
        const uint8_t __seq0[] = { 0x00 };
        const uint8_t __seq1[] = { 0x01 };
        const uint8_t __seq2[] = { 0x00 };
        const uint8_t __seq3[] = { 0x01 };
        const uint8_t __seq4[] = { 0x02 };
        const uint8_t __seq5[] = { 0x01 };
        const uint8_t __seq6[] = { 0x00 };

        if (!HAL_I2C_BurstWrite_Port(port, address, 0x88, __seq0, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x80, __seq1, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xFF, __seq1, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, __seq0, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x91, __seq2, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, __seq1, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xFF, __seq0, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x80, __seq0, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, __seq3, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, __seq6, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xFF, __seq1, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, __seq4, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, __seq5, 1, &instance->ERR_ID)) return;
        if (!HAL_I2C_BurstWrite_Port(port, address, 0xFF, __seq0, 1, &instance->ERR_ID)) return;
    }

    instance->OK = true;
}

static inline void {{TYPE_NAME}}_Call({{TYPE_NAME}} *instance) {
    instance->ENO = instance->EN;
    instance->OK = false;
    instance->ERR_ID = 0;
    if (!instance->EN) return;
    if (!instance->_configured) { instance->ERR_ID = 1; return; }

    {
        const uint8_t __start[] = { 0x01 };
        if (!HAL_I2C_BurstWrite_Port(instance->_port, instance->_address, 0x00, __start, 1, &instance->ERR_ID)) return;
    }

    uint8_t __buf[12] = {0};
    if (!HAL_I2C_BurstRead_Port(instance->_port, instance->_address, 0x14, __buf, 12, &instance->ERR_ID)) return;

    instance->{{DIST_FIELD}} = (int16_t)__kron_u16_be(__buf + 10);
    instance->OK = true;
}
