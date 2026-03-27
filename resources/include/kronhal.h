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
#include <stddef.h>
#include <string.h>

typedef void* POINTER;

#ifndef KRON_RUNTIME_PORT_HELPERS
#define KRON_RUNTIME_PORT_HELPERS 0
static inline bool KRON_I2C_PortEnabled(uint8_t port) {
    (void)port;
    return true;
}
static inline bool KRON_SPI_PortResolve(uint8_t port, uint8_t *bus, uint8_t *cs, uint8_t *mode, uint8_t *bit_order, int32_t *clk_hz, bool *enabled) {
    if (bus) *bus = (uint8_t)(port / 2U);
    if (cs) *cs = (uint8_t)(port % 2U);
    if (mode) *mode = 0;
    if (bit_order) *bit_order = 0;
    if (clk_hz) *clk_hz = 1000000;
    if (enabled) *enabled = true;
    return true;
}
static inline bool KRON_UART_PortEnabled(uint8_t port) {
    return port < 6U;
}
static inline int32_t KRON_UART_PortBaud(uint8_t port) {
    (void)port;
    return 115200;
}
static inline uint8_t KRON_UART_PortParity(uint8_t port) {
    (void)port;
    return 0;
}
static inline uint8_t KRON_UART_PortStopBits(uint8_t port) {
    (void)port;
    return 1;
}
#endif

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
 * I2C Burst Read  (multi-byte block read, channel-based, max 4)
 *   BUFFER : caller-allocated array of at least LEN bytes.
 *   LEN    : 1..255  (larger values silently fail in BurstWrite)
 *   ERR_ID : 0=OK  1=bad arg / null ptr  2=bus open fail  3=I/O error
 * =================================================================*/
typedef struct {
    uint8_t  ADDR;    /* 7-bit I2C device address                       */
    uint8_t  REG;     /* Starting register (sub-address)                */
    uint16_t LEN;     /* Number of bytes to read                        */
    uint8_t *BUFFER;  /* Caller-owned RX buffer (must be >= LEN bytes)  */
    bool     EN;
    bool     OK;
    bool     ENO;
    int8_t   ERR_ID;
} HAL_I2C_BurstRead;

/* ===================================================================
 * I2C Burst Write  (multi-byte block write, channel-based, max 4)
 *   BUFFER holds LEN data bytes; REG is prepended automatically.
 *   LEN    : 1..255
 * =================================================================*/
typedef struct {
    uint8_t        ADDR;    /* 7-bit I2C device address                 */
    uint8_t        REG;     /* Starting register (sub-address)          */
    uint16_t       LEN;     /* Number of data bytes to write (1..255)   */
    const uint8_t *BUFFER;  /* Caller-owned TX data buffer              */
    bool           EN;
    bool           OK;
    bool           ENO;
    int8_t         ERR_ID;
} HAL_I2C_BurstWrite;

/* ===================================================================
 * SPI Burst Transfer  (full-duplex multi-byte, channel-based, max 4)
 *   TX_BUF / RX_BUF : may be NULL for rx-only / tx-only transfers.
 *   LEN    : 1..255
 *   CS     : CS line index for the bus (0 = CE0, 1 = CE1, …)
 *   MODE   : SPI mode 0–3
 *   BIT_ORDER : 0 = MSB first (standard)
 *   ERR_ID : 0=OK 1=bad arg 2=device open fail 3=transfer error
 * =================================================================*/
typedef struct {
    uint8_t        MODE;       /* SPI mode 0–3                          */
    uint8_t        BIT_ORDER;  /* 0 = MSB first, 1 = LSB first          */
    int32_t        CLK_HZ;     /* Clock frequency in Hz                 */
    uint8_t        CS;         /* CS line index for this bus            */
    uint16_t       LEN;        /* Transfer length in bytes (1..255)     */
    const uint8_t *TX_BUF;     /* Transmit buffer (LEN bytes, or NULL)  */
    uint8_t       *RX_BUF;     /* Receive buffer  (LEN bytes, or NULL)  */
    bool           EN;
    bool           DONE;
    bool           ENO;
    int8_t         ERR_ID;
} HAL_SPI_BurstTransfer;

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
 * Generic communication FBs (project runtime layer)
 * =================================================================*/
typedef struct {
    bool     Execute;
    uint8_t  Port_ID;
    uint8_t  Device_Address;
    uint8_t  Register_Address;
    POINTER  pTxBuffer;
    uint16_t TxLength;
    POINTER  pRxBuffer;
    uint16_t RxLength;
    bool     Done;
    bool     Busy;
    bool     Error;
    bool     _prev_execute;
    uint8_t  _phase;
    int8_t   _err_id;
} I2C_WriteRead;

typedef struct {
    bool     Execute;
    uint8_t  Port_ID;
    POINTER  pTxBuffer;
    POINTER  pRxBuffer;
    uint16_t Length;
    bool     Done;
    bool     Busy;
    bool     Error;
    bool     _prev_execute;
    uint8_t  _phase;
    int8_t   _err_id;
} SPI_Transfer;

typedef struct {
    bool     Execute;
    uint8_t  Port_ID;
    POINTER  pTxBuffer;
    uint16_t Length;
    bool     Done;
    bool     Busy;
    bool     Error;
    bool     _prev_execute;
    uint8_t  _phase;
    int8_t   _err_id;
} UART_Send;

typedef struct {
    bool     Enable;
    uint8_t  Port_ID;
    POINTER  pRxBuffer;
    uint16_t MaxSize;
    bool     NewData;
    uint16_t ReceivedLength;
    bool     Error;
    int8_t   _err_id;
} UART_Receive;


/* ===================================================================
 * Conditional implementation include
 * (all struct typedefs must be defined before this point)
 * =================================================================*/
#if defined(HAL_SIM_MODE)
#include "kronhal_sim.h"
#elif defined(HAL_BOARD_FAMILY_JETSON)
#include "kronhal_jetson.h"
#elif defined(HAL_BOARD_FAMILY_RPI)
#include "kronhal_rpi.h"
#elif defined(HAL_BOARD_FAMILY_PICO)
#include "kronhal_pico.h"
#elif defined(HAL_BOARD_FAMILY_BB)
#include "kronhal_bb.h"
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

/* I2C Burst Read */
static inline void I2C0_BurstRead_Call(HAL_I2C_BurstRead *i) { HAL_I2C_BurstRead_Call(i, 0); }
static inline void I2C1_BurstRead_Call(HAL_I2C_BurstRead *i) { HAL_I2C_BurstRead_Call(i, 1); }
static inline void I2C2_BurstRead_Call(HAL_I2C_BurstRead *i) { HAL_I2C_BurstRead_Call(i, 2); }
static inline void I2C3_BurstRead_Call(HAL_I2C_BurstRead *i) { HAL_I2C_BurstRead_Call(i, 3); }

/* I2C Burst Write */
static inline void I2C0_BurstWrite_Call(HAL_I2C_BurstWrite *i) { HAL_I2C_BurstWrite_Call(i, 0); }
static inline void I2C1_BurstWrite_Call(HAL_I2C_BurstWrite *i) { HAL_I2C_BurstWrite_Call(i, 1); }
static inline void I2C2_BurstWrite_Call(HAL_I2C_BurstWrite *i) { HAL_I2C_BurstWrite_Call(i, 2); }
static inline void I2C3_BurstWrite_Call(HAL_I2C_BurstWrite *i) { HAL_I2C_BurstWrite_Call(i, 3); }

/* SPI Burst Transfer */
static inline void SPI0_BurstTransfer_Call(HAL_SPI_BurstTransfer *i) { HAL_SPI_BurstTransfer_Call(i, 0); }
static inline void SPI1_BurstTransfer_Call(HAL_SPI_BurstTransfer *i) { HAL_SPI_BurstTransfer_Call(i, 1); }
static inline void SPI2_BurstTransfer_Call(HAL_SPI_BurstTransfer *i) { HAL_SPI_BurstTransfer_Call(i, 2); }
static inline void SPI3_BurstTransfer_Call(HAL_SPI_BurstTransfer *i) { HAL_SPI_BurstTransfer_Call(i, 3); }

/* Device-oriented helpers used by autogenerated typed sensor FBs.
 * They preserve the HAL boundary while allowing project-specific code
 * to target arbitrary Linux bus numbers without raw void* payload work.
 */
static inline bool HAL_I2C_BurstRead_Port(uint8_t port, uint8_t dev_addr, uint8_t reg_addr, uint8_t *buffer, uint16_t len, int8_t *err_id) {
    HAL_I2C_BurstRead req = {
        .ADDR = dev_addr, .REG = reg_addr, .LEN = len, .BUFFER = buffer,
        .EN = true, .OK = false, .ENO = false, .ERR_ID = 0
    };
    HAL_I2C_BurstRead_Call(&req, port);
    if (err_id) *err_id = req.ERR_ID;
    return req.OK;
}

static inline bool HAL_I2C_BurstWrite_Port(uint8_t port, uint8_t dev_addr, uint8_t reg_addr, const uint8_t *buffer, uint16_t len, int8_t *err_id) {
    HAL_I2C_BurstWrite req = {
        .ADDR = dev_addr, .REG = reg_addr, .LEN = len, .BUFFER = buffer,
        .EN = true, .OK = false, .ENO = false, .ERR_ID = 0
    };
    HAL_I2C_BurstWrite_Call(&req, port);
    if (err_id) *err_id = req.ERR_ID;
    return req.OK;
}

static inline bool HAL_SPI_BurstTransfer_Port(uint8_t port, uint8_t cs, uint8_t mode, uint8_t bit_order, int32_t clk_hz, const uint8_t *tx, uint8_t *rx, uint16_t len, int8_t *err_id) {
    HAL_SPI_BurstTransfer req = {
        .MODE = mode, .BIT_ORDER = bit_order, .CLK_HZ = clk_hz, .CS = cs, .LEN = len,
        .TX_BUF = tx, .RX_BUF = rx, .EN = true, .DONE = false, .ENO = false, .ERR_ID = 0
    };
    HAL_SPI_BurstTransfer_Call(&req, port);
    if (err_id) *err_id = req.ERR_ID;
    return req.DONE;
}

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

/* ===================================================================
 * Generic communication runtime helpers
 * =================================================================*/
#define KRON_COMM_PHASE_IDLE 0
#define KRON_COMM_PHASE_BUSY 1

#if defined(__linux__)
#include <pthread.h>
#include <unistd.h>

#define KRON_UART_RUNTIME_PORTS 6
#define KRON_UART_RING_CAPACITY 1024

typedef struct {
    pthread_t       thread;
    pthread_mutex_t lock;
    bool            lock_ready;
    bool            running;
    bool            thread_started;
    uint8_t         buffer[KRON_UART_RING_CAPACITY];
    uint16_t        head;
    uint16_t        tail;
    uint16_t        count;
    bool            overflow;
    int8_t          last_error;
} KRON_UART_RuntimePort;

static KRON_UART_RuntimePort __kron_uart_runtime[KRON_UART_RUNTIME_PORTS];

static inline void *__kron_uart_runtime_thread(void *arg) {
    const uint8_t port = (uint8_t)(uintptr_t)arg;
    KRON_UART_RuntimePort *rt = &__kron_uart_runtime[port];

    while (rt->running) {
        HAL_UART_Receive rx = {0};
        rx.EN = true;
        rx.BAUD = KRON_UART_PortBaud(port);
        rx.TIMEOUT = 0;
        HAL_UART_Receive_Call(&rx, port);

        if (rx.ERR_ID != 0) {
            if (rt->lock_ready) {
                pthread_mutex_lock(&rt->lock);
                rt->last_error = rx.ERR_ID;
                pthread_mutex_unlock(&rt->lock);
            }
            usleep(1000);
            continue;
        }

        if (!rx.READY) {
            usleep(1000);
            continue;
        }

        if (!rt->lock_ready) continue;
        pthread_mutex_lock(&rt->lock);
        if (rt->count < KRON_UART_RING_CAPACITY) {
            rt->buffer[rt->head] = rx.DATA;
            rt->head = (uint16_t)((rt->head + 1U) % KRON_UART_RING_CAPACITY);
            rt->count++;
        } else {
            rt->overflow = true;
        }
        pthread_mutex_unlock(&rt->lock);
    }

    return NULL;
}

static inline void KRON_UART_RuntimeInit(void) {
    uint8_t port;
    for (port = 0; port < KRON_UART_RUNTIME_PORTS; port++) {
        KRON_UART_RuntimePort *rt = &__kron_uart_runtime[port];
        if (!KRON_UART_PortEnabled(port) || rt->thread_started) continue;
        if (pthread_mutex_init(&rt->lock, NULL) != 0) continue;
        rt->lock_ready = true;
        rt->running = true;
        rt->thread_started = (pthread_create(&rt->thread, NULL, __kron_uart_runtime_thread, (void *)(uintptr_t)port) == 0);
        if (!rt->thread_started) {
            rt->running = false;
            pthread_mutex_destroy(&rt->lock);
            rt->lock_ready = false;
        }
    }
}

static inline void KRON_UART_RuntimeCleanup(void) {
    uint8_t port;
    for (port = 0; port < KRON_UART_RUNTIME_PORTS; port++) {
        KRON_UART_RuntimePort *rt = &__kron_uart_runtime[port];
        if (rt->thread_started) {
            rt->running = false;
            pthread_join(rt->thread, NULL);
            rt->thread_started = false;
        }
        if (rt->lock_ready) {
            pthread_mutex_destroy(&rt->lock);
            rt->lock_ready = false;
        }
        rt->count = 0;
        rt->head = 0;
        rt->tail = 0;
        rt->overflow = false;
        rt->last_error = 0;
    }
}

static inline uint16_t __kron_uart_drain_port(uint8_t port, uint8_t *buffer, uint16_t max_size, bool *overflow, int8_t *err_id) {
    uint16_t copied = 0;
    KRON_UART_RuntimePort *rt;
    if (overflow) *overflow = false;
    if (err_id) *err_id = 0;
    if (port >= KRON_UART_RUNTIME_PORTS) return 0;
    rt = &__kron_uart_runtime[port];
    if (!rt->lock_ready) return 0;

    pthread_mutex_lock(&rt->lock);
    while (copied < max_size && rt->count > 0U) {
        buffer[copied++] = rt->buffer[rt->tail];
        rt->tail = (uint16_t)((rt->tail + 1U) % KRON_UART_RING_CAPACITY);
        rt->count--;
    }
    if (overflow) *overflow = rt->overflow;
    if (err_id) *err_id = rt->last_error;
    rt->overflow = false;
    rt->last_error = 0;
    pthread_mutex_unlock(&rt->lock);
    return copied;
}
#else
static inline void KRON_UART_RuntimeInit(void) {}
static inline void KRON_UART_RuntimeCleanup(void) {}
static inline uint16_t __kron_uart_drain_port(uint8_t port, uint8_t *buffer, uint16_t max_size, bool *overflow, int8_t *err_id) {
    uint16_t copied = 0;
    if (overflow) *overflow = false;
    if (err_id) *err_id = 0;
    while (copied < max_size) {
        HAL_UART_Receive rx = {0};
        rx.EN = true;
        rx.BAUD = KRON_UART_PortBaud(port);
        rx.TIMEOUT = 0;
        HAL_UART_Receive_Call(&rx, port);
        if (rx.ERR_ID != 0) {
            if (err_id) *err_id = rx.ERR_ID;
            break;
        }
        if (!rx.READY) break;
        buffer[copied++] = rx.DATA;
    }
    return copied;
}
#endif

static inline void I2C_WriteRead_Call(I2C_WriteRead *inst) {
    const bool rising = inst->Execute && !inst->_prev_execute;
    inst->Done = false;
    if (inst->_phase == KRON_COMM_PHASE_IDLE && rising) {
        inst->Busy = true;
        inst->Error = false;
        inst->_phase = KRON_COMM_PHASE_BUSY;
    } else if (inst->_phase == KRON_COMM_PHASE_BUSY) {
        bool ok = true;
        inst->_err_id = 0;
        if (!KRON_I2C_PortEnabled(inst->Port_ID)
            || (inst->TxLength == 0U && inst->RxLength == 0U)
            || (inst->TxLength > 0U && inst->pTxBuffer == NULL)
            || (inst->RxLength > 0U && inst->pRxBuffer == NULL)) {
            ok = false;
            inst->_err_id = 1;
        }
        if (ok && inst->TxLength > 0U) {
            ok = HAL_I2C_BurstWrite_Port(inst->Port_ID, inst->Device_Address, inst->Register_Address, (const uint8_t *)inst->pTxBuffer, inst->TxLength, &inst->_err_id);
        }
        if (ok && inst->RxLength > 0U) {
            ok = HAL_I2C_BurstRead_Port(inst->Port_ID, inst->Device_Address, inst->Register_Address, (uint8_t *)inst->pRxBuffer, inst->RxLength, &inst->_err_id);
        }
        inst->Done = ok;
        inst->Busy = false;
        inst->Error = !ok;
        inst->_phase = KRON_COMM_PHASE_IDLE;
    } else {
        inst->Busy = false;
    }
    inst->_prev_execute = inst->Execute;
}

static inline void SPI_Transfer_Call(SPI_Transfer *inst) {
    const bool rising = inst->Execute && !inst->_prev_execute;
    inst->Done = false;
    if (inst->_phase == KRON_COMM_PHASE_IDLE && rising) {
        inst->Busy = true;
        inst->Error = false;
        inst->_phase = KRON_COMM_PHASE_BUSY;
    } else if (inst->_phase == KRON_COMM_PHASE_BUSY) {
        bool ok = false;
        bool enabled = false;
        uint8_t bus = 0, cs = 0, mode = 0, bit_order = 0;
        int32_t clk_hz = 1000000;
        inst->_err_id = 0;
        if (inst->Length == 0U || (inst->pTxBuffer == NULL && inst->pRxBuffer == NULL)) {
            inst->_err_id = 1;
        } else if (KRON_SPI_PortResolve(inst->Port_ID, &bus, &cs, &mode, &bit_order, &clk_hz, &enabled) && enabled) {
            ok = HAL_SPI_BurstTransfer_Port(bus, cs, mode, bit_order, clk_hz, (const uint8_t *)inst->pTxBuffer, (uint8_t *)inst->pRxBuffer, inst->Length, &inst->_err_id);
        } else {
            inst->_err_id = 1;
        }
        inst->Done = ok;
        inst->Busy = false;
        inst->Error = !ok;
        inst->_phase = KRON_COMM_PHASE_IDLE;
    } else {
        inst->Busy = false;
    }
    inst->_prev_execute = inst->Execute;
}

static inline void UART_Send_Call(UART_Send *inst) {
    const bool rising = inst->Execute && !inst->_prev_execute;
    inst->Done = false;
    if (inst->_phase == KRON_COMM_PHASE_IDLE && rising) {
        inst->Busy = true;
        inst->Error = false;
        inst->_phase = KRON_COMM_PHASE_BUSY;
    } else if (inst->_phase == KRON_COMM_PHASE_BUSY) {
        bool ok = true;
        uint16_t index;
        const uint8_t *buffer = (const uint8_t *)inst->pTxBuffer;
        inst->_err_id = 0;
        if (!KRON_UART_PortEnabled(inst->Port_ID) || inst->Length == 0U || buffer == NULL) {
            ok = false;
            inst->_err_id = 1;
        }
        for (index = 0; ok && index < inst->Length; index++) {
            HAL_UART_Send tx = {0};
            tx.EN = true;
            tx.BAUD = KRON_UART_PortBaud(inst->Port_ID);
            tx.DATA = buffer[index];
            HAL_UART_Send_Call(&tx, inst->Port_ID);
            ok = tx.DONE && tx.ERR_ID == 0;
            inst->_err_id = tx.ERR_ID;
        }
        inst->Done = ok;
        inst->Busy = false;
        inst->Error = !ok;
        inst->_phase = KRON_COMM_PHASE_IDLE;
    } else {
        inst->Busy = false;
    }
    inst->_prev_execute = inst->Execute;
}

static inline void UART_Receive_Call(UART_Receive *inst) {
    bool overflow = false;
    uint8_t *buffer = (uint8_t *)inst->pRxBuffer;
    inst->NewData = false;
    inst->ReceivedLength = 0;
    inst->Error = false;
    inst->_err_id = 0;
    if (!inst->Enable) return;
    if (!KRON_UART_PortEnabled(inst->Port_ID) || buffer == NULL || inst->MaxSize == 0U) {
        inst->Error = true;
        inst->_err_id = 1;
        return;
    }
    inst->ReceivedLength = __kron_uart_drain_port(inst->Port_ID, buffer, inst->MaxSize, &overflow, &inst->_err_id);
    inst->NewData = inst->ReceivedLength > 0U;
    inst->Error = overflow || inst->_err_id != 0;
}

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
