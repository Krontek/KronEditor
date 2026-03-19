/*
 * kronhal.h  --  KronEditor Hardware Abstraction Layer (HAL)
 *
 * Abstract API for all board-specific blocks (GPIO, PWM, SPI, I2C, UART,
 * ADC, CAN, PRU, PCM, Grove).  Each block type has a matching C struct.
 *
 * Channel-based blocks (PWM0, SPI0_Transfer, ...) are typedef'd to the
 * base struct and wrapped with static-inline channel dispatchers.
 *
 * Layout:
 *   1. Struct / typedef definitions  (needed by board-specific headers)
 *   2. Conditional implementation include  (pulls in static inline _Call fns)
 *   3. Channel dispatcher wrappers  (call the base _Call functions)
 *
 * ERR_ID convention (int8_t, applies to all HAL blocks):
 *   0  = OK / no error
 *   1  = Invalid / unsupported pin or channel index
 *   2  = Hardware init failed (e.g. I2C open error)
 *   3  = Hardware I/O error (e.g. I2C read/write failed)
 *   Additional board-specific codes may be defined per block in the future.
 */
#ifndef KRONHAL_H
#define KRONHAL_H

#include <stdint.h>
#include <stdbool.h>

/* ===================================================================
 * GPIO
 * =================================================================*/
typedef struct {
    int16_t PIN;
    bool    EN;
    bool    VALUE;
    bool    ENO;
    int8_t  ERR_ID;
} GPIO_Read;

typedef struct {
    int16_t PIN;
    bool    VALUE;
    bool    EN;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} GPIO_Write;

typedef struct {
    int16_t PIN;
    int16_t MODE;
    bool    EN;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} GPIO_SetMode;

/* ===================================================================
 * PWM  (channel-based, max 8)
 * =================================================================*/
typedef struct {
    float  DUTY;
    float  FREQ;
    bool   EN;
    bool   ACTIVE;
    bool   ENO;
    int8_t ERR_ID;
} HAL_PWM;

typedef HAL_PWM PWM0;
typedef HAL_PWM PWM1;
typedef HAL_PWM PWM2;
typedef HAL_PWM PWM3;
typedef HAL_PWM PWM4;
typedef HAL_PWM PWM5;
typedef HAL_PWM PWM6;
typedef HAL_PWM PWM7;

/* ===================================================================
 * SPI  (channel-based, max 4)
 * =================================================================*/
typedef struct {
    uint8_t TX_DATA;
    int16_t CS;
    int32_t CLK_HZ;
    bool    EN;
    uint8_t RX_DATA;
    bool    DONE;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_SPI;

typedef HAL_SPI SPI0_Transfer;
typedef HAL_SPI SPI1_Transfer;
typedef HAL_SPI SPI2_Transfer;
typedef HAL_SPI SPI3_Transfer;

/* ===================================================================
 * I2C Read  (channel-based, max 4)
 * =================================================================*/
typedef struct {
    uint8_t ADDR;
    uint8_t REG;
    int16_t LEN;
    bool    EN;
    uint8_t DATA;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_I2C_Read;

typedef HAL_I2C_Read I2C0_Read;
typedef HAL_I2C_Read I2C1_Read;
typedef HAL_I2C_Read I2C2_Read;
typedef HAL_I2C_Read I2C3_Read;

/* ===================================================================
 * I2C Write  (channel-based, max 4)
 * =================================================================*/
typedef struct {
    uint8_t ADDR;
    uint8_t REG;
    uint8_t DATA;
    bool    EN;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_I2C_Write;

typedef HAL_I2C_Write I2C0_Write;
typedef HAL_I2C_Write I2C1_Write;
typedef HAL_I2C_Write I2C2_Write;
typedef HAL_I2C_Write I2C3_Write;

/* ===================================================================
 * UART Send  (channel-based, max 6)
 * =================================================================*/
typedef struct {
    uint8_t DATA;
    int32_t BAUD;
    bool    EN;
    bool    DONE;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_UART_Send;

typedef HAL_UART_Send UART0_Send;
typedef HAL_UART_Send UART1_Send;
typedef HAL_UART_Send UART2_Send;
typedef HAL_UART_Send UART3_Send;
typedef HAL_UART_Send UART4_Send;
typedef HAL_UART_Send UART5_Send;

/* ===================================================================
 * UART Receive  (channel-based, max 6)
 * =================================================================*/
typedef struct {
    int32_t BAUD;
    int16_t TIMEOUT;
    bool    EN;
    uint8_t DATA;
    bool    READY;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_UART_Receive;

typedef HAL_UART_Receive UART0_Receive;
typedef HAL_UART_Receive UART1_Receive;
typedef HAL_UART_Receive UART2_Receive;
typedef HAL_UART_Receive UART3_Receive;
typedef HAL_UART_Receive UART4_Receive;
typedef HAL_UART_Receive UART5_Receive;

/* ===================================================================
 * ADC Read  (channel-based, max 7)
 * =================================================================*/
typedef struct {
    bool    TRIGGER;
    bool    EN;
    int16_t VALUE;
    float   VOLTAGE;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_ADC_Read;

typedef HAL_ADC_Read ADC0_Read;
typedef HAL_ADC_Read ADC1_Read;
typedef HAL_ADC_Read ADC2_Read;
typedef HAL_ADC_Read ADC3_Read;
typedef HAL_ADC_Read ADC4_Read;
typedef HAL_ADC_Read ADC5_Read;
typedef HAL_ADC_Read ADC6_Read;

/* ===================================================================
 * CAN Send  (channel-based, max 2)
 * =================================================================*/
typedef struct {
    int32_t ID;
    uint8_t DATA;
    int16_t DLC;
    bool    EN;
    bool    DONE;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_CAN_Send;

typedef HAL_CAN_Send CAN0_Send;
typedef HAL_CAN_Send CAN1_Send;

/* ===================================================================
 * CAN Receive  (channel-based, max 2)
 * =================================================================*/
typedef struct {
    int32_t FILTER_ID;
    bool    EN;
    int32_t ID;
    uint8_t DATA;
    bool    READY;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_CAN_Receive;

typedef HAL_CAN_Receive CAN0_Receive;
typedef HAL_CAN_Receive CAN1_Receive;

/* ===================================================================
 * PRU Execute  (channel-based, max 4)
 * =================================================================*/
typedef struct {
    int16_t CMD;
    int32_t PARAM;
    bool    EN;
    int32_t RESULT;
    bool    DONE;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_PRU_Execute;

typedef HAL_PRU_Execute PRU0_Execute;
typedef HAL_PRU_Execute PRU1_Execute;
typedef HAL_PRU_Execute PRU2_Execute;
typedef HAL_PRU_Execute PRU3_Execute;

/* ===================================================================
 * PCM (static blocks)
 * =================================================================*/
typedef struct {
    int16_t DATA;
    int32_t RATE;
    bool    EN;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} PCM_Output;

typedef struct {
    int32_t RATE;
    bool    EN;
    int16_t DATA;
    bool    READY;
    bool    ENO;
    int8_t  ERR_ID;
} PCM_Input;

/* ===================================================================
 * Grove (static blocks)
 * =================================================================*/
typedef struct {
    int16_t PORT;
    bool    EN;
    bool    VALUE;
    bool    ENO;
    int8_t  ERR_ID;
} Grove_DigitalRead;

typedef struct {
    int16_t PORT;
    bool    VALUE;
    bool    EN;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} Grove_DigitalWrite;

typedef struct {
    int16_t PORT;
    bool    EN;
    int16_t VALUE;
    float   VOLTAGE;
    bool    ENO;
    int8_t  ERR_ID;
} Grove_AnalogRead;

/* ===================================================================
 * DI – Isolated Digital Input  (channel-based, max 8)
 * =================================================================*/
typedef struct {
    int16_t CHANNEL;
    bool    EN;
    bool    VALUE;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_DI_Read;

typedef HAL_DI_Read DI0_Read;
typedef HAL_DI_Read DI1_Read;
typedef HAL_DI_Read DI2_Read;
typedef HAL_DI_Read DI3_Read;
typedef HAL_DI_Read DI4_Read;
typedef HAL_DI_Read DI5_Read;
typedef HAL_DI_Read DI6_Read;
typedef HAL_DI_Read DI7_Read;

/* ===================================================================
 * DO – Isolated Digital Output  (channel-based, max 8)
 * =================================================================*/
typedef struct {
    int16_t CHANNEL;
    bool    VALUE;
    bool    EN;
    bool    OK;
    bool    ENO;
    int8_t  ERR_ID;
} HAL_DO_Write;

typedef HAL_DO_Write DO0_Write;
typedef HAL_DO_Write DO1_Write;
typedef HAL_DO_Write DO2_Write;
typedef HAL_DO_Write DO3_Write;
typedef HAL_DO_Write DO4_Write;
typedef HAL_DO_Write DO5_Write;
typedef HAL_DO_Write DO6_Write;
typedef HAL_DO_Write DO7_Write;

/* ===================================================================
 * Conditional implementation include
 * (all struct typedefs must be defined before this point)
 * =================================================================*/
#if defined(HAL_SIM_MODE)
#include "kronhal_sim.h"
#elif defined(HAL_BOARD_FAMILY_RPI)
#include "kronhal_rpi.h"
#elif defined(HAL_BOARD_FAMILY_PICO)
#include "kronhal_pico.h"
#elif defined(HAL_BOARD_FAMILY_BB)
#include "kronhal_bb.h"
#elif defined(HAL_BOARD_FAMILY_EDATEC)
#include "kronhal_edatec.h"
#else
#include "kronhal_sim.h"
#endif

/* ===================================================================
 * Channel dispatcher wrappers
 * (must come AFTER the conditional include so the base _Call fns are defined)
 * =================================================================*/

/* PWM */
static inline void PWM0_Call(HAL_PWM *i) { HAL_PWM_Call(i, 0); }
static inline void PWM1_Call(HAL_PWM *i) { HAL_PWM_Call(i, 1); }
static inline void PWM2_Call(HAL_PWM *i) { HAL_PWM_Call(i, 2); }
static inline void PWM3_Call(HAL_PWM *i) { HAL_PWM_Call(i, 3); }
static inline void PWM4_Call(HAL_PWM *i) { HAL_PWM_Call(i, 4); }
static inline void PWM5_Call(HAL_PWM *i) { HAL_PWM_Call(i, 5); }
static inline void PWM6_Call(HAL_PWM *i) { HAL_PWM_Call(i, 6); }
static inline void PWM7_Call(HAL_PWM *i) { HAL_PWM_Call(i, 7); }

/* SPI */
static inline void SPI0_Transfer_Call(HAL_SPI *i) { HAL_SPI_Call(i, 0); }
static inline void SPI1_Transfer_Call(HAL_SPI *i) { HAL_SPI_Call(i, 1); }
static inline void SPI2_Transfer_Call(HAL_SPI *i) { HAL_SPI_Call(i, 2); }
static inline void SPI3_Transfer_Call(HAL_SPI *i) { HAL_SPI_Call(i, 3); }

/* I2C Read */
static inline void I2C0_Read_Call(HAL_I2C_Read *i) { HAL_I2C_Read_Call(i, 0); }
static inline void I2C1_Read_Call(HAL_I2C_Read *i) { HAL_I2C_Read_Call(i, 1); }
static inline void I2C2_Read_Call(HAL_I2C_Read *i) { HAL_I2C_Read_Call(i, 2); }
static inline void I2C3_Read_Call(HAL_I2C_Read *i) { HAL_I2C_Read_Call(i, 3); }

/* I2C Write */
static inline void I2C0_Write_Call(HAL_I2C_Write *i) { HAL_I2C_Write_Call(i, 0); }
static inline void I2C1_Write_Call(HAL_I2C_Write *i) { HAL_I2C_Write_Call(i, 1); }
static inline void I2C2_Write_Call(HAL_I2C_Write *i) { HAL_I2C_Write_Call(i, 2); }
static inline void I2C3_Write_Call(HAL_I2C_Write *i) { HAL_I2C_Write_Call(i, 3); }

/* UART Send */
static inline void UART0_Send_Call(HAL_UART_Send *i) { HAL_UART_Send_Call(i, 0); }
static inline void UART1_Send_Call(HAL_UART_Send *i) { HAL_UART_Send_Call(i, 1); }
static inline void UART2_Send_Call(HAL_UART_Send *i) { HAL_UART_Send_Call(i, 2); }
static inline void UART3_Send_Call(HAL_UART_Send *i) { HAL_UART_Send_Call(i, 3); }
static inline void UART4_Send_Call(HAL_UART_Send *i) { HAL_UART_Send_Call(i, 4); }
static inline void UART5_Send_Call(HAL_UART_Send *i) { HAL_UART_Send_Call(i, 5); }

/* UART Receive */
static inline void UART0_Receive_Call(HAL_UART_Receive *i) { HAL_UART_Receive_Call(i, 0); }
static inline void UART1_Receive_Call(HAL_UART_Receive *i) { HAL_UART_Receive_Call(i, 1); }
static inline void UART2_Receive_Call(HAL_UART_Receive *i) { HAL_UART_Receive_Call(i, 2); }
static inline void UART3_Receive_Call(HAL_UART_Receive *i) { HAL_UART_Receive_Call(i, 3); }
static inline void UART4_Receive_Call(HAL_UART_Receive *i) { HAL_UART_Receive_Call(i, 4); }
static inline void UART5_Receive_Call(HAL_UART_Receive *i) { HAL_UART_Receive_Call(i, 5); }

/* ADC */
static inline void ADC0_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 0); }
static inline void ADC1_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 1); }
static inline void ADC2_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 2); }
static inline void ADC3_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 3); }
static inline void ADC4_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 4); }
static inline void ADC5_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 5); }
static inline void ADC6_Read_Call(HAL_ADC_Read *i) { HAL_ADC_Read_Call(i, 6); }

/* CAN */
static inline void CAN0_Send_Call(HAL_CAN_Send *i) { HAL_CAN_Send_Call(i, 0); }
static inline void CAN1_Send_Call(HAL_CAN_Send *i) { HAL_CAN_Send_Call(i, 1); }
static inline void CAN0_Receive_Call(HAL_CAN_Receive *i) { HAL_CAN_Receive_Call(i, 0); }
static inline void CAN1_Receive_Call(HAL_CAN_Receive *i) { HAL_CAN_Receive_Call(i, 1); }

/* PRU */
static inline void PRU0_Execute_Call(HAL_PRU_Execute *i) { HAL_PRU_Execute_Call(i, 0); }
static inline void PRU1_Execute_Call(HAL_PRU_Execute *i) { HAL_PRU_Execute_Call(i, 1); }
static inline void PRU2_Execute_Call(HAL_PRU_Execute *i) { HAL_PRU_Execute_Call(i, 2); }
static inline void PRU3_Execute_Call(HAL_PRU_Execute *i) { HAL_PRU_Execute_Call(i, 3); }

/* DI – Isolated Digital Input */
static inline void DI0_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 0); }
static inline void DI1_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 1); }
static inline void DI2_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 2); }
static inline void DI3_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 3); }
static inline void DI4_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 4); }
static inline void DI5_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 5); }
static inline void DI6_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 6); }
static inline void DI7_Read_Call(HAL_DI_Read *i) { HAL_DI_Read_Call(i, 7); }

/* DO – Isolated Digital Output */
static inline void DO0_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 0); }
static inline void DO1_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 1); }
static inline void DO2_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 2); }
static inline void DO3_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 3); }
static inline void DO4_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 4); }
static inline void DO5_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 5); }
static inline void DO6_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 6); }
static inline void DO7_Write_Call(HAL_DO_Write *i) { HAL_DO_Write_Call(i, 7); }

#endif /* KRONHAL_H */
