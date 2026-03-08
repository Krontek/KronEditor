/*===========================================================================
 * KronCommunication — Industrial Communication Protocol Stubs
 *
 * Protocols:
 *   MODBUS_RTU_MASTER  — Modbus RTU master (RS-485/RS-232)
 *   MODBUS_RTU_SLAVE   — Modbus RTU slave
 *   MODBUS_TCP_CLIENT  — Modbus TCP client (Ethernet)
 *   MQTT_CLIENT        — MQTT client (IoT broker)
 *   CAN_NODE           — CAN bus node (ISO 11898)
 *   UART               — Generic UART / serial port
 *
 * Pure-C utilities (fully implemented, no hardware dependency):
 *   KRON_CRC16_Modbus            — CRC-16/IBM for RTU framing
 *   KRON_ModbusRTU_BuildRequest  — build an RTU ADU in a byte buffer
 *   KRON_ModbusRTU_ParseResponse — parse an RTU response byte buffer
 *   KRON_ModbusTCP_BuildRequest  — build a TCP ADU (MBAP + PDU)
 *   KRON_ModbusTCP_ParseResponse — parse a TCP response byte buffer
 *
 * Hardware-dependent calls (STUB — fill in for your MCU/OS):
 *   XXX_Init(XXX *inst)                — one-time hardware init
 *   XXX_Call(XXX *inst, currentTime)   — cyclic scan call
 *
 * Call pattern: XXX_Call(XXX *inst, inputs...)  — IEC 61131-3 style.
 * All structs are zero-initializable as a safe default state.
 *
 * No external dependencies. C99. Baremetal Cortex-M4 compatible.
 *===========================================================================*/

#ifndef KRONCOMM_H
#define KRONCOMM_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

/*===========================================================================
 * Common error codes  (ErrorCode field on all blocks)
 *===========================================================================*/
#define KRONCOMM_OK                   0x00u
#define KRONCOMM_ERR_TIMEOUT          0x01u  /* no response within Timeout */
#define KRONCOMM_ERR_CRC              0x02u  /* CRC mismatch */
#define KRONCOMM_ERR_FRAME            0x03u  /* malformed frame */
#define KRONCOMM_ERR_EXCEPTION        0x04u  /* Modbus exception received */
#define KRONCOMM_ERR_OVERFLOW         0x05u  /* buffer overflow */
#define KRONCOMM_ERR_NOT_CONNECTED    0x06u  /* TCP/MQTT not connected */
#define KRONCOMM_ERR_HARDWARE         0x07u  /* peripheral fault */
#define KRONCOMM_ERR_BUSY             0x08u  /* previous request still pending */
#define KRONCOMM_ERR_INVALID_PARAM    0x09u  /* bad parameter (address, qty…) */

/*===========================================================================
 * Modbus constants
 *===========================================================================*/
/* Function codes */
#define MODBUS_FC_READ_COILS               0x01u
#define MODBUS_FC_READ_DISCRETE_INPUTS     0x02u
#define MODBUS_FC_READ_HOLDING_REGISTERS   0x03u
#define MODBUS_FC_READ_INPUT_REGISTERS     0x04u
#define MODBUS_FC_WRITE_SINGLE_COIL        0x05u
#define MODBUS_FC_WRITE_SINGLE_REGISTER    0x06u
#define MODBUS_FC_WRITE_MULTIPLE_COILS     0x0Fu
#define MODBUS_FC_WRITE_MULTIPLE_REGISTERS 0x10u

/* Standard Modbus exception codes */
#define MODBUS_EX_ILLEGAL_FUNCTION         0x01u
#define MODBUS_EX_ILLEGAL_ADDRESS          0x02u
#define MODBUS_EX_ILLEGAL_DATA_VALUE       0x03u
#define MODBUS_EX_SERVER_FAILURE           0x04u
#define MODBUS_EX_ACKNOWLEDGE              0x05u
#define MODBUS_EX_SERVER_BUSY              0x06u
#define MODBUS_EX_NEGATIVE_ACK             0x07u
#define MODBUS_EX_MEMORY_PARITY_ERROR      0x08u

/* Buffer / data-model limits */
#define KRONCOMM_MODBUS_MAX_REGS        125u  /* max registers per request (spec limit) */
#define KRONCOMM_MODBUS_RTU_FRAME_SIZE  256u  /* max RTU ADU bytes */
#define KRONCOMM_MODBUS_TCP_FRAME_SIZE  260u  /* max TCP ADU bytes (6 MBAP + 254 PDU) */
#define KRONCOMM_MODBUS_SLAVE_COILS_SIZE 128u /* slave data model — coil/discrete count */
#define KRONCOMM_MODBUS_SLAVE_REGS_SIZE  128u /* slave data model — register count */

/*===========================================================================
 * Pure-C Modbus utilities  (implemented — no hardware needed)
 *===========================================================================*/

/*---------------------------------------------------------------------------
 * CRC-16/IBM (Modbus variant)
 *   Polynomial: 0xA001 (reflected 0x8005)
 *   Initial value: 0xFFFF
 *   Returns the 16-bit CRC. Append as [CRC_lo, CRC_hi] in RTU frames.
 *-------------------------------------------------------------------------*/
uint16_t KRON_CRC16_Modbus(const uint8_t *data, uint16_t len);

/*---------------------------------------------------------------------------
 * KRON_ModbusRTU_BuildRequest
 *   Builds a complete RTU ADU (SlaveAddr + PDU + CRC) into buf.
 *   buf must be at least KRONCOMM_MODBUS_RTU_FRAME_SIZE bytes.
 *
 *   Supported function codes:
 *     FC01/02/03/04  — read:  quantity = number of coils/registers
 *     FC05           — write single coil:   writeData[0] = 0x0000 or 0xFF00
 *     FC06           — write single register: writeData[0] = value
 *     FC0F (15)      — write multiple coils:     writeData[i] bit-packed
 *     FC10 (16)      — write multiple registers: writeData[0..qty-1]
 *
 *   Returns: frame length in bytes (0 on invalid parameters).
 *-------------------------------------------------------------------------*/
uint16_t KRON_ModbusRTU_BuildRequest(uint8_t        *buf,
                                     uint8_t         slaveAddr,
                                     uint8_t         fc,
                                     uint16_t        startAddr,
                                     uint16_t        quantity,
                                     const uint16_t *writeData);

/*---------------------------------------------------------------------------
 * KRON_ModbusRTU_ParseResponse
 *   Validates CRC, slave address, function code, and extracts register data.
 *
 *   readData : output buffer for read FCs (NULL for write-only FCs).
 *   maxRegs  : capacity of readData.
 *
 *   Returns: KRONCOMM_OK on success,
 *            KRONCOMM_ERR_CRC / ERR_FRAME on format error,
 *            KRONCOMM_ERR_EXCEPTION + *exceptionCode set on Modbus exception.
 *-------------------------------------------------------------------------*/
uint8_t KRON_ModbusRTU_ParseResponse(const uint8_t *buf,
                                     uint16_t       len,
                                     uint8_t        expectedSlaveAddr,
                                     uint8_t        expectedFC,
                                     uint16_t      *readData,
                                     uint16_t       maxRegs,
                                     uint8_t       *exceptionCode);

/*---------------------------------------------------------------------------
 * KRON_ModbusTCP_BuildRequest
 *   Builds a Modbus TCP ADU: 6-byte MBAP header + PDU.
 *   buf must be at least KRONCOMM_MODBUS_TCP_FRAME_SIZE bytes.
 *   Returns: frame length in bytes (0 on invalid parameters).
 *-------------------------------------------------------------------------*/
uint16_t KRON_ModbusTCP_BuildRequest(uint8_t        *buf,
                                     uint16_t        transactionId,
                                     uint8_t         unitId,
                                     uint8_t         fc,
                                     uint16_t        startAddr,
                                     uint16_t        quantity,
                                     const uint16_t *writeData);

/*---------------------------------------------------------------------------
 * KRON_ModbusTCP_ParseResponse
 *   Validates MBAP fields and extracts register data.
 *   Returns: KRONCOMM_OK / KRONCOMM_ERR_FRAME / KRONCOMM_ERR_EXCEPTION.
 *-------------------------------------------------------------------------*/
uint8_t KRON_ModbusTCP_ParseResponse(const uint8_t *buf,
                                     uint16_t       len,
                                     uint16_t       expectedTransId,
                                     uint8_t        expectedUnitId,
                                     uint8_t        expectedFC,
                                     uint16_t      *readData,
                                     uint16_t       maxRegs,
                                     uint8_t       *exceptionCode);

/*===========================================================================
 * MODBUS_RTU_MASTER
 *
 * Rising edge of Execute triggers one request.
 * Poll Done/Busy/Error each scan for result.
 *
 * For read FCs  (01,02,03,04): results appear in ReadData[].
 * For write FCs (05,06,0F,10): supply data in WriteData[].
 *===========================================================================*/
typedef struct {
    /* --- Configuration (set once before Init) --- */
    uint32_t Baudrate;           /* e.g. 9600, 19200, 115200            */
    uint8_t  Parity;             /* 0=None, 1=Even, 2=Odd               */
    uint8_t  StopBits;           /* 1 or 2                              */
    uint32_t Timeout;            /* response timeout [ms]               */

    /* --- Cyclic inputs --- */
    bool     Execute;
    uint8_t  SlaveAddress;       /* 1–247                               */
    uint8_t  FunctionCode;       /* MODBUS_FC_*                         */
    uint16_t StartAddress;       /* 0-based coil/register address       */
    uint16_t Quantity;           /* coils or registers                  */
    uint16_t WriteData[KRONCOMM_MODBUS_MAX_REGS];

    /* --- Outputs --- */
    bool     Done;
    bool     Busy;
    bool     Error;
    uint8_t  ErrorCode;          /* KRONCOMM_ERR_*                      */
    uint8_t  ExceptionCode;      /* MODBUS_EX_* (valid when ERR_EXCEPTION) */
    uint16_t ReadData[KRONCOMM_MODBUS_MAX_REGS];

    /* --- Internal --- */
    bool     _prevExecute;
} MODBUS_RTU_MASTER;

void MODBUS_RTU_MASTER_Init(MODBUS_RTU_MASTER *inst);
void MODBUS_RTU_MASTER_Call(MODBUS_RTU_MASTER *inst, uint32_t currentTime);

/*===========================================================================
 * MODBUS_RTU_SLAVE
 *
 * The data model arrays are shared memory between the application and the
 * Modbus stack. The application reads/writes them directly each scan cycle.
 * CoilWritten / RegisterWritten pulse for one cycle when master writes.
 *===========================================================================*/
typedef struct {
    /* --- Configuration --- */
    uint8_t  SlaveAddress;       /* 1–247                               */
    uint32_t Baudrate;
    uint8_t  Parity;             /* 0=None, 1=Even, 2=Odd               */
    uint8_t  StopBits;

    /* --- Data model (application reads/writes these) --- */
    bool     Coils[KRONCOMM_MODBUS_SLAVE_COILS_SIZE];
    bool     DiscreteInputs[KRONCOMM_MODBUS_SLAVE_COILS_SIZE];
    uint16_t HoldingRegisters[KRONCOMM_MODBUS_SLAVE_REGS_SIZE];
    uint16_t InputRegisters[KRONCOMM_MODBUS_SLAVE_REGS_SIZE];

    /* --- Outputs --- */
    bool     Active;
    bool     CoilWritten;        /* pulsed one scan when master wrote coils   */
    bool     RegisterWritten;    /* pulsed one scan when master wrote regs    */
    bool     Error;
    uint8_t  ErrorCode;
} MODBUS_RTU_SLAVE;

void MODBUS_RTU_SLAVE_Init(MODBUS_RTU_SLAVE *inst);
void MODBUS_RTU_SLAVE_Call(MODBUS_RTU_SLAVE *inst, uint32_t currentTime);

/*===========================================================================
 * MODBUS_TCP_CLIENT
 *
 * Rising edge of Connect initiates TCP connection.
 * Rising edge of Execute (while Connected) triggers one Modbus request.
 *===========================================================================*/
typedef struct {
    /* --- Configuration --- */
    uint8_t  ServerIP[4];        /* e.g. {192, 168, 1, 100}             */
    uint16_t ServerPort;         /* default 502                         */
    uint32_t Timeout;            /* connect + response timeout [ms]     */

    /* --- Cyclic inputs --- */
    bool     Connect;
    bool     Execute;
    uint8_t  UnitId;             /* Modbus unit identifier (=slave addr) */
    uint8_t  FunctionCode;
    uint16_t StartAddress;
    uint16_t Quantity;
    uint16_t WriteData[KRONCOMM_MODBUS_MAX_REGS];

    /* --- Outputs --- */
    bool     Connected;
    bool     Done;
    bool     Busy;
    bool     Error;
    uint8_t  ErrorCode;
    uint8_t  ExceptionCode;
    uint16_t ReadData[KRONCOMM_MODBUS_MAX_REGS];
    uint16_t TransactionId;      /* last used MBAP transaction ID       */

    /* --- Internal --- */
    bool     _prevConnect;
    bool     _prevExecute;
    uint16_t _transactionCounter;
} MODBUS_TCP_CLIENT;

void MODBUS_TCP_CLIENT_Init(MODBUS_TCP_CLIENT *inst);
void MODBUS_TCP_CLIENT_Call(MODBUS_TCP_CLIENT *inst, uint32_t currentTime);

/*===========================================================================
 * MQTT_CLIENT
 *
 * Rising edge of Connect initiates broker connection.
 * Rising edge of Publish (while Connected) sends one message.
 * Rising edge of Subscribe (while Connected) subscribes to SubTopic.
 * MsgReceived pulses one scan when an inbound message arrives;
 * RcvTopic / RcvPayload / RcvPayloadLen hold the content.
 *===========================================================================*/
#define KRONCOMM_MQTT_TOPIC_LEN      128u
#define KRONCOMM_MQTT_PAYLOAD_LEN    512u
#define KRONCOMM_MQTT_CLIENT_ID_LEN   32u
#define KRONCOMM_MQTT_CRED_LEN        64u

typedef enum {
    MQTT_QOS_0 = 0,   /* At most once  (fire and forget)  */
    MQTT_QOS_1 = 1,   /* At least once (acknowledged)     */
    MQTT_QOS_2 = 2    /* Exactly once  (four-way handshake)*/
} MQTT_QOS;

typedef struct {
    /* --- Configuration --- */
    uint8_t  BrokerIP[4];
    uint16_t BrokerPort;         /* 1883 (plain) or 8883 (TLS)          */
    char     ClientId[KRONCOMM_MQTT_CLIENT_ID_LEN];
    char     Username[KRONCOMM_MQTT_CRED_LEN];
    char     Password[KRONCOMM_MQTT_CRED_LEN];
    uint16_t KeepAlive;          /* keep-alive interval [s]             */
    bool     CleanSession;

    /* --- Connect input --- */
    bool     Connect;

    /* --- Publish inputs --- */
    bool     Publish;
    char     PubTopic[KRONCOMM_MQTT_TOPIC_LEN];
    uint8_t  PubPayload[KRONCOMM_MQTT_PAYLOAD_LEN];
    uint16_t PubPayloadLen;
    MQTT_QOS PubQos;
    bool     PubRetain;

    /* --- Subscribe inputs --- */
    bool     Subscribe;
    char     SubTopic[KRONCOMM_MQTT_TOPIC_LEN];
    MQTT_QOS SubQos;

    /* --- Outputs --- */
    bool     Connected;
    bool     PubDone;
    bool     SubDone;
    bool     Error;
    uint8_t  ErrorCode;

    /* Inbound message (valid for one scan cycle after MsgReceived) */
    bool     MsgReceived;
    char     RcvTopic[KRONCOMM_MQTT_TOPIC_LEN];
    uint8_t  RcvPayload[KRONCOMM_MQTT_PAYLOAD_LEN];
    uint16_t RcvPayloadLen;

    /* --- Internal --- */
    bool     _prevConnect;
    bool     _prevPublish;
    bool     _prevSubscribe;
} MQTT_CLIENT;

void MQTT_CLIENT_Init(MQTT_CLIENT *inst);
void MQTT_CLIENT_Call(MQTT_CLIENT *inst, uint32_t currentTime);
void MQTT_CLIENT_Disconnect(MQTT_CLIENT *inst);

/*===========================================================================
 * CAN_NODE
 *
 * Rising edge of Send transmits TxFrame.
 * MsgReceived pulses one scan when a frame passes the acceptance filter;
 * RxFrame holds the received data.
 * TxErrorCount / RxErrorCount reflect the CAN error counters.
 *===========================================================================*/
typedef enum {
    CAN_BAUDRATE_125K  = 125000,
    CAN_BAUDRATE_250K  = 250000,
    CAN_BAUDRATE_500K  = 500000,
    CAN_BAUDRATE_1M    = 1000000
} CAN_BAUDRATE;

typedef struct {
    uint32_t Id;           /* 11-bit or 29-bit frame ID        */
    uint8_t  DataLen;      /* 0–8 bytes (DLC)                  */
    uint8_t  Data[8];
    bool     IsExtended;   /* true = 29-bit extended ID        */
    bool     IsRTR;        /* Remote Transmission Request      */
} CAN_FRAME;

typedef struct {
    /* --- Configuration --- */
    uint32_t Baudrate;           /* CAN_BAUDRATE_*                      */
    uint32_t FilterId;           /* acceptance filter base ID           */
    uint32_t FilterMask;         /* acceptance filter mask (0 = off)    */

    /* --- Inputs --- */
    bool      Enable;
    bool      Send;
    CAN_FRAME TxFrame;

    /* --- Outputs --- */
    bool      Active;
    bool      SendDone;
    bool      MsgReceived;
    CAN_FRAME RxFrame;
    bool      Error;
    uint8_t   ErrorCode;
    uint8_t   TxErrorCount;
    uint8_t   RxErrorCount;

    /* --- Internal --- */
    bool      _prevSend;
} CAN_NODE;

void CAN_NODE_Init(CAN_NODE *inst);
void CAN_NODE_Call(CAN_NODE *inst, uint32_t currentTime);

/*===========================================================================
 * UART
 *
 * Rising edge of Send transmits TxData[0..TxLen-1].
 * RxAvailable is true while unread data sits in RxData.
 * Call UART_ClearRx() to acknowledge and reset the receive buffer.
 * RtsEnable = true enables RTS/DE line control (RS-485 direction).
 *===========================================================================*/
#define KRONCOMM_UART_BUFFER_SIZE 256u

typedef enum {
    UART_PARITY_NONE = 0,
    UART_PARITY_EVEN = 1,
    UART_PARITY_ODD  = 2
} UART_PARITY;

typedef struct {
    /* --- Configuration --- */
    uint32_t    Baudrate;
    uint8_t     DataBits;        /* 7 or 8                              */
    UART_PARITY Parity;
    uint8_t     StopBits;        /* 1 or 2                              */
    bool        RtsEnable;       /* RS-485 direction control via RTS/DE */

    /* --- Inputs --- */
    bool     Enable;
    bool     Send;
    uint8_t  TxData[KRONCOMM_UART_BUFFER_SIZE];
    uint16_t TxLen;

    /* --- Outputs --- */
    bool     Active;
    bool     SendDone;
    bool     RxAvailable;
    uint8_t  RxData[KRONCOMM_UART_BUFFER_SIZE];
    uint16_t RxLen;
    bool     Error;
    uint8_t  ErrorCode;

    /* --- Internal --- */
    bool     _prevSend;
} UART;

void UART_Init(UART *inst);
void UART_Call(UART *inst, uint32_t currentTime);
void UART_ClearRx(UART *inst);

#endif /* KRONCOMM_H */
