# KronServer API Documentation

KronServer is a Go-based PLC deployment and debug agent that runs on target hardware (Raspberry Pi, Jetson, BeagleBone, x86_64). It manages the PLC runtime lifecycle, provides live variable access via shared memory IPC, and serves an HMI web interface.

**Default address:** `:7070`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       KronEditor                            │
│  (Tauri + React desktop app — compiles PLC projects)        │
└────────────┬───────────────────────────────────┬────────────┘
             │  Deploy (HTTP POST)               │  ConnectRPC
             │  - runtime.bin                    │  - Start/Stop
             │  - variable_table.json            │  - StreamVars
             │  - runtime_config.json            │  - WriteVar
             ▼                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                       KronServer                            │
│                    (Go, static binary)                       │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ ProcessMgr   │  │  IPCManager  │  │   APIManager      │ │
│  │ (start/stop  │  │  (mmap SHM)  │  │   (REST /api/v1)  │ │
│  │  runtime.bin)│  │              │  │                   │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────┘ │
│         │                 │                                 │
│         │    /dev/shm/plc_runtime (shared memory)           │
│         ▼                 ▼                                 │
│  ┌─────────────────────────────────────────┐                │
│  │           PLC Runtime (C binary)        │                │
│  │  - Reads/writes variables via SHM       │                │
│  │  - Runs cyclic PLC tasks                │                │
│  └─────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
             ▲                          ▲
             │  REST API /api/v1        │  SSE /api/v1/stream
             │  (Bearer token auth)     │  cadence configurable via
             │  - variables read/write  │  /api/v1/runtime/config
             │  - runtime start/stop    │
             │  - runtime config        │
┌────────────┴──────────────────────────┴─────────────────────┐
│  External Clients: Python, SCADA, HMI, custom dashboards    │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `IPCManager` | `ipc.go` | mmap shared memory, read/write variables, variable table management |
| `ProcessManager` | `process.go` | Start/stop PLC runtime binary, SIGTERM/SIGKILL lifecycle |
| `PLCService` | `service.go` | ConnectRPC handler (Start, Stop, WriteVar, StreamVars) |
| `APIManager` | `api.go` | REST API for addressed variables (external access) |
| `HMIManager` | `hmi.go` | Web-based HMI with RBAC |
| `SessionStore` | `auth.go` | Token-based authentication, 8h TTL |
| `Server` | `server.go` | HTTP server, route registration, CORS, deploy endpoints |

### Shared Memory IPC

The PLC runtime and KronServer communicate through a shared memory region (`/dev/shm/plc_runtime` by default, 64 KB). Variables are read/written at byte offsets defined in `variable_table.json`. All multi-byte values use **Little Endian** encoding.

**Force flags:** When a variable is force-written via the API, its `force_flag_offset` byte in SHM is set to `1`. The PLC runtime's `plc_shm_sync` skips overwriting variables with active force flags, ensuring the forced value persists until cleared.

---

## CLI Flags

```bash
./plc-agent \
  -addr ":7070" \
  -deploy-dir "/opt/plc" \
  -shm-name "plc_runtime" \
  -shm-size 65536 \
  -log-level "info"
```

| Flag | Default | Description |
|------|---------|-------------|
| `-addr` | `:7070` | HTTP listen address |
| `-deploy-dir` | `/opt/plc` | Working directory for binaries, logs, config |
| `-shm-name` | `plc_runtime` | Shared memory name under `/dev/shm/` |
| `-shm-size` | `65536` | Shared memory size in bytes (64 KB) |
| `-log-level` | `info` | `debug`, `info`, `warn`, `error` |

---

## Data Types

Supported PLC variable types and their sizes:

| VarType | Size (bytes) | JSON type | Example |
|---------|-------------|-----------|---------|
| `bool` | 1 | `boolean` | `true` |
| `int8` | 1 | `number` | `-128` |
| `uint8` | 1 | `number` | `255` |
| `int16` | 2 | `number` | `-32768` |
| `uint16` | 2 | `number` | `65535` |
| `int32` | 4 | `number` | `2147483647` |
| `uint32` | 4 | `number` | `4294967295` |
| `int64` | 8 | `number` | `9223372036854775807` |
| `uint64` | 8 | `number` | `18446744073709551615` |
| `float32` | 4 | `number` | `3.14` |
| `float64` | 8 | `number` | `3.141592653589793` |

---

## Variable Table (`variable_table.json`)

Uploaded via `POST /deploy/variable-table`. Defines the symbol table for SHM access.

```json
{
  "variables": [
    {
      "name": "prog__motor_speed",
      "offset": 0,
      "type": "float32",
      "size": 4,
      "force_flag_offset": 32768,
      "address": "%MD0",
      "initial_value": 0.0
    },
    {
      "name": "prog__pump_on",
      "offset": 4,
      "type": "bool",
      "size": 1,
      "force_flag_offset": 32769,
      "address": "%MX0.4",
      "initial_value": true
    },
    {
      "name": "prog__internal_counter",
      "offset": 5,
      "type": "int32",
      "size": 4,
      "force_flag_offset": 32770
    }
  ],
  "api_password_hash": "a1b2c3d4e5f6...",
  "api_password_salt": "d4e5f6a1b2c3..."
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | C variable name (e.g. `prog__motor_speed`) |
| `offset` | int | Yes | Byte offset in shared memory |
| `type` | string | Yes | One of the supported VarType values |
| `size` | int | Yes | Size in bytes (must match type) |
| `force_flag_offset` | int | No | Byte offset of force flag in SHM |
| `address` | string | No | IEC address (e.g. `%MW0`). **Non-empty = exposed via REST API** |
| `initial_value` | any | No | Value written to SHM before runtime starts |

### Addressed vs Non-Addressed Variables

- **Addressed** (`address` field is non-empty): Exposed via the REST API (`/api/v1/variables`). These are variables the user explicitly marked for external access in KronEditor.
- **Non-addressed** (`address` field is empty or missing): Only accessible via ConnectRPC `StreamVars`/`WriteVar`. Used internally by the editor for simulation/debug.

### IEC Address Format

| IEC Type | Address Format | Example |
|----------|---------------|---------|
| BOOL | `%MX{byte}.{bit}` | `%MX1.3` |
| BYTE/SINT/USINT | `%MB{n}` | `%MB5` |
| INT/UINT/WORD | `%MW{n}` | `%MW10` |
| DINT/UDINT/DWORD/REAL/TIME | `%MD{n}` | `%MD0` |
| LINT/ULINT/LWORD/LREAL | `%ML{n}` | `%ML4` |

---

## REST API (`/api/v1/`)

Password-protected REST API for external clients (Python, SCADA, HMI dashboards). Only **addressed** variables are accessible.

### Authentication

The API uses a single shared password set in KronEditor's Settings > Connection tab. The password is hashed (SHA-256 with 16-byte salt) and embedded in `variable_table.json`. If no password is configured, the API returns `503 Service Unavailable`.

**Flow:**
1. Client sends password to `POST /api/v1/auth`
2. Server returns a bearer token (64-byte random hex, 8h TTL)
3. Client includes `Authorization: Bearer <token>` in all subsequent requests

---

### `POST /api/v1/auth`

Authenticate and receive a bearer token.

**Request:**
```http
POST /api/v1/auth
Content-Type: application/json

{"password": "my_api_password"}
```

**Response (200):**
```json
{"token": "a1b2c3d4e5f6..."}
```

**Errors:**
| Status | Body | Condition |
|--------|------|-----------|
| 503 | `{"error": "API is not configured (no password set)"}` | No password in variable_table.json |
| 400 | `{"error": "invalid JSON"}` | Malformed request body |
| 401 | `{"error": "invalid password"}` | Wrong password |

---

### `GET /api/v1/variables`

Read all addressed variables.

**Request:**
```http
GET /api/v1/variables
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "prog__motor_speed": 1500.0,
  "prog__pump_on": true,
  "prog__temperature": 25.5
}
```

---

### `GET /api/v1/variables/{name}`

Read a single addressed variable with metadata.

**Request:**
```http
GET /api/v1/variables/prog__motor_speed
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "name": "prog__motor_speed",
  "value": 1500.0,
  "type": "float32",
  "address": "%MD0"
}
```

**Errors:**
| Status | Body | Condition |
|--------|------|-----------|
| 404 | `{"error": "variable not found or not addressed: xyz"}` | Variable does not exist or has no address |

---

### `POST /api/v1/variables/{name}`

Write a value to a single addressed variable. Sets the force flag so the PLC runtime will not overwrite this value.

**Request:**
```http
POST /api/v1/variables/prog__motor_speed
Authorization: Bearer <token>
Content-Type: application/json

{"value": 1200.0}
```

**Response (200):**
```json
{"status": "ok"}
```

**Value format:** The `value` field accepts native JSON types (`true`, `42`, `3.14`). String values like `"1"`, `"true"`, `"3.14"` are automatically coerced to the correct type.

**Errors:**
| Status | Body | Condition |
|--------|------|-----------|
| 404 | `{"error": "variable not found or not addressed: xyz"}` | Variable does not exist or has no address |
| 400 | `{"error": "invalid JSON"}` | Malformed body |
| 500 | `{"error": "..."}` | Encoding or SHM write failure |

---

### `GET /api/v1/stream`

Server-Sent Events (SSE) stream of all addressed variables. Pushes a JSON snapshot at the cadence configured by `stream_interval_ms` (default **50 ms**, range **5–60000 ms**). Cadence changes via `POST /api/v1/runtime/config` apply immediately to all in-flight streams without reconnect. Sends a heartbeat comment every 25 seconds to keep the connection alive.

**Request:**
```http
GET /api/v1/stream
Authorization: Bearer <token>
```

**Response (200, text/event-stream):**
```
data: {"prog__motor_speed":1500.0,"prog__pump_on":true}

data: {"prog__motor_speed":1501.2,"prog__pump_on":true}

: heartbeat

data: {"prog__motor_speed":1502.0,"prog__pump_on":false}
```

**Usage (Python):**
```python
import requests
import json

token = requests.post("http://plc:7070/api/v1/auth",
    json={"password": "secret"}).json()["token"]

with requests.get("http://plc:7070/api/v1/stream",
    headers={"Authorization": f"Bearer {token}"},
    stream=True) as r:
    for line in r.iter_lines():
        if line and line.startswith(b"data: "):
            data = json.loads(line[6:])
            print(data)
```

**Usage (JavaScript):**
```javascript
const token = await fetch("/api/v1/auth", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: "secret" })
}).then(r => r.json()).then(r => r.token);

const es = new EventSource(`/api/v1/stream?token=${token}`);
// Note: EventSource does not support custom headers.
// For browser clients, pass the token as a query parameter
// or use fetch() with ReadableStream instead.
```

---

### `POST /api/v1/forces/clear`

Clear all force flags on addressed variables. After clearing, the PLC runtime resumes overwriting these variables with its computed values during `plc_shm_sync`.

**Request:**
```http
POST /api/v1/forces/clear
Authorization: Bearer <token>
```

**Response (200):**
```json
{"status": "ok"}
```

---

### `GET /api/v1/runtime`

Read the current PLC runtime status and persistent runtime config in a single call.

**Request:**
```http
GET /api/v1/runtime
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "running": true,
  "pid": 12345,
  "auto_run": false,
  "stream_interval_ms": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `running` | bool | Whether the PLC runtime process is alive |
| `pid` | int | PID of the runtime process (`0` if not running) |
| `auto_run` | bool | Whether AutoRun-on-boot is enabled |
| `stream_interval_ms` | int | Effective `/api/v1/stream` cadence in milliseconds |

---

### `POST /api/v1/runtime/start`

Launch the PLC runtime binary. Writes initial values from `variable_table.json` to shared memory before spawning the process. If a process is already running, it is stopped first.

**Request:**
```http
POST /api/v1/runtime/start
Authorization: Bearer <token>
```

**Response (200):**
```json
{"running": true, "pid": 12345}
```

**Errors:**
| Status | Body | Condition |
|--------|------|-----------|
| 500 | `{"error": "runtime binary not found: ..."}` | `runtime.bin` not deployed |
| 500 | `{"error": "..."}` | Spawn / SHM failure |

---

### `POST /api/v1/runtime/stop`

Gracefully terminate the PLC runtime: SIGTERM, wait up to 5 seconds, then SIGKILL. Returns immediately once the process has exited (or there was none to stop).

**Request:**
```http
POST /api/v1/runtime/stop
Authorization: Bearer <token>
```

**Response (200):**
```json
{"running": false}
```

---

### `POST /api/v1/runtime/config`

Partial update of persistent runtime configuration. Only fields present in the body are changed; omitted fields keep their current value. Persisted to `{deploy-dir}/runtime_config.json` and applied immediately.

**Request:**
```http
POST /api/v1/runtime/config
Authorization: Bearer <token>
Content-Type: application/json

{"auto_run": true, "stream_interval_ms": 100}
```

| Field | Type | Optional | Effect |
|-------|------|----------|--------|
| `auto_run` | bool | yes | Whether the runtime is started automatically next time the agent boots |
| `stream_interval_ms` | uint | yes | New `/api/v1/stream` cadence; clamped to **5–60000**. Applies to in-flight SSE clients on the next tick |

**Response (200):** the resulting (post-clamp) snapshot.
```json
{"auto_run": true, "stream_interval_ms": 100}
```

**Errors:**
| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{"error": "invalid JSON"}` | Malformed request body |

> Note: this only affects the **`/api/v1/stream`** endpoint. The editor-facing streams (`/stream/vars` and ConnectRPC `StreamVars`) keep their fixed 50 ms cadence regardless of this setting.

---

## Deploy Endpoints

Used by KronEditor to upload the compiled PLC binary and configuration. No authentication required (same trust level as physical access to the device).

### `POST /deploy/runtime`

Upload the compiled PLC runtime binary. Saved atomically as `{deploy-dir}/runtime.bin` with executable permissions (0755). Max upload size: **128 MB**.

**Request:**
```http
POST /deploy/runtime
Content-Type: application/octet-stream

<binary data>
```

**Response (200):**
```json
{"status": "ok", "path": "/opt/plc/runtime.bin"}
```

---

### `POST /deploy/variable-table`

Upload the variable table JSON. The server parses and validates it immediately. Validation checks:
- No empty variable names
- No unsupported types
- Size matches type
- No out-of-bounds offsets
- No duplicate variable names

**Request:**
```http
POST /deploy/variable-table
Content-Type: application/json

<variable_table.json content>
```

**Response (200):**
```json
{"status": "ok", "path": "/opt/plc/variable_table.json", "variable_count": 42}
```

**Errors:**
| Status | Body | Condition |
|--------|------|-----------|
| 422 | `"failed to parse table: ..."` | JSON parse error, validation failure |

---

### `POST /deploy/config`

Upload runtime configuration. Persisted as `{deploy-dir}/runtime_config.json`. Accepts a partial JSON body — fields that are omitted are left untouched, so the editor can push `{"auto_run": false}` without clobbering an API-tuned `stream_interval_ms` (and vice versa).

**Request:**
```http
POST /deploy/config
Content-Type: application/json

{"auto_run": true, "stream_interval_ms": 100}
```

| Field | Type | Optional | Effect |
|-------|------|----------|--------|
| `auto_run` | bool | yes | Whether the runtime is started automatically when the agent boots |
| `stream_interval_ms` | uint | yes | `/api/v1/stream` cadence in ms; clamped to **5–60000** |

**Response (200):** the resulting (post-clamp) snapshot.
```json
{"auto_run": true, "stream_interval_ms": 100}
```

When `auto_run` is `true`, the server automatically starts the PLC runtime on startup (after writing initial values to SHM). The `stream_interval_ms` field is identical to the one accepted by `POST /api/v1/runtime/config` and affects only the `/api/v1/stream` endpoint.

---

### `GET /status`

Returns the current server and runtime status.

**Request:**
```http
GET /status
```

**Response (200):**
```json
{
  "running": true,
  "pid": 12345,
  "variable_count": 42,
  "shm_name": "plc_runtime",
  "deploy_dir": "/opt/plc",
  "auto_run": false,
  "stream_interval_ms": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `running` | bool | Whether the PLC runtime process is alive |
| `pid` | int | PID of the runtime process (0 if not running) |
| `variable_count` | int | Number of loaded variables |
| `shm_name` | string | Shared memory region name |
| `deploy_dir` | string | Deploy directory path |
| `auto_run` | bool | Whether AutoRun is enabled |
| `stream_interval_ms` | int | Effective `/api/v1/stream` cadence in ms |

> `/status` is unauthenticated and primarily intended for liveness checks from the editor and load balancers. For authenticated programmatic access prefer `GET /api/v1/runtime`.

---

## ConnectRPC Service (`/plc.v1.PLCService/`)

Used internally by KronEditor for runtime control and live variable streaming. Supports Connect, gRPC, and gRPC-Web protocols over HTTP/2 (h2c, no TLS).

### Proto Definition

```protobuf
service PLCService {
  rpc Start(StartRequest) returns (StartResponse);
  rpc Stop(StopRequest) returns (StopResponse);
  rpc WriteVar(WriteVarRequest) returns (WriteVarResponse);
  rpc ClearAllForces(ClearAllForcesRequest) returns (ClearAllForcesResponse);
  rpc StreamVars(StreamVarsRequest) returns (stream VarsUpdate);
}
```

### `Start`

Launches `{deploy-dir}/runtime.bin`. Writes initial values to SHM first. If a process is already running, stops it before starting a new one. The runtime runs in its own process group and continues even if the agent exits.

**Response:** `{ pid: int32 }`

### `Stop`

Sends SIGTERM to the runtime. Waits up to **5 seconds** for graceful shutdown, then sends SIGKILL.

### `WriteVar`

Force-writes a variable value into shared memory and sets the force flag. The PLC runtime will not overwrite forced variables during its sync cycle.

**Request:** `{ name: string, value: google.protobuf.Value }`

### `ClearAllForces`

Clears all force flags. The runtime resumes normal `plc_shm_sync` for all variables.

### `StreamVars`

Server-streaming RPC. Pushes a full variable snapshot (all variables, not just addressed) every **50 ms** as `google.protobuf.Struct`. Includes a Unix millisecond timestamp.

**Response stream:** `{ variables: google.protobuf.Struct, ts: int64 }`

---

## SSE Variable Stream (`/stream/vars`)

Unauthenticated SSE endpoint that streams **all** variables (not just addressed) every 50 ms. Used by the KronEditor Tauri client where fetch-based streaming is buffered. Same format as `/api/v1/stream` but without token requirement and includes all variables.

```
data: {"prog__motor_speed":1500.0,"prog__pump_on":true,"prog__internal_counter":42}
```

---

## Authentication & Authorization

### REST API Auth (Bearer Token)

- Single shared password configured in KronEditor
- Password hashed with SHA-256: `SHA256(salt + ":" + password)`
- Salt: 16-byte random hex string
- Token: 64-byte random hex string
- Token TTL: **8 hours**
- Expired sessions cleaned up every 15 minutes
- API clients receive `RoleOperator` level access

### HMI Auth (Cookie Session)

- Per-user accounts with 4-tier RBAC
- Session stored in `kron_session` cookie
- Same 8h TTL as API tokens

### RBAC Roles

| Role | Level | Permissions |
|------|-------|-------------|
| `viewer` | 1 | Read-only on permitted HMI pages |
| `operator` | 2 | Read + write on operational pages |
| `maintainer` | 3 | Read + write on all pages |
| `admin` | 4 | Full access including user management |

---

## Runtime Artifacts

Files created/managed in `{deploy-dir}` (default `/opt/plc`):

```
/opt/plc/
├── runtime.bin                        # Compiled PLC binary (uploaded)
├── variable_table.json                # Variable symbol table (uploaded)
├── runtime_config.json                # AutoRun + /api/v1/stream cadence
├── hmi_layout.json                    # HMI page config (created by HMI deploy)
└── logs/
    ├── runtime_20260410_143000_stdout.log
    └── runtime_20260410_143000_stderr.log
```

### `runtime_config.json`

Persisted across restarts. Written by `POST /deploy/config` and `POST /api/v1/runtime/config`; both endpoints accept partial updates and merge field-by-field.

```json
{
  "auto_run": true,
  "stream_interval_ms": 100
}
```

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `auto_run` | bool | `false` | Start `runtime.bin` automatically when the agent boots |
| `stream_interval_ms` | uint | `50` | `/api/v1/stream` cadence (clamped 5–60000); editor streams ignore it |

---

## Typical Workflow

```
1. KronEditor compiles PLC project → generates runtime.bin + variable_table.json

2. Deploy to target:
   POST /deploy/runtime         ← upload binary
   POST /deploy/variable-table  ← upload symbol table
   POST /deploy/config          ← set auto_run flag (optional)

3. Start runtime:
   ConnectRPC Start()           ← editor: writes initial values, spawns process
   POST /api/v1/runtime/start   ← external client: same effect, REST + bearer token

4. Monitor variables:
   ConnectRPC StreamVars()      ← editor uses this (all variables, fixed 50 ms)
   GET /api/v1/stream           ← external clients (addressed only, tunable cadence)

5. Force-write a variable:
   ConnectRPC WriteVar()        ← from editor
   POST /api/v1/variables/{n}   ← from external client

6. Stop runtime:
   ConnectRPC Stop()            ← from editor
   POST /api/v1/runtime/stop    ← from external client (SIGTERM → 5s → SIGKILL)

7. Inspect / tune runtime config:
   GET  /api/v1/runtime         ← running, pid, auto_run, stream_interval_ms
   POST /api/v1/runtime/config  ← partial update of auto_run / stream_interval_ms
```

---

## Error Response Format

All REST API errors return JSON:

```json
{"error": "description of what went wrong"}
```

HTTP status codes used:
- `400` — Bad request (malformed JSON, missing parameters)
- `401` — Unauthorized (missing/invalid token or password)
- `403` — Forbidden (insufficient role)
- `404` — Variable not found or not addressed
- `422` — Unprocessable entity (validation failure)
- `500` — Internal server error (SHM failure, encoding error)
- `503` — Service unavailable (API not configured)

---

## CORS

All endpoints return permissive CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Connect-Protocol-Version,
    Connect-Timeout-Ms, Grpc-Timeout, X-Grpc-Web, X-User-Agent
```

Preflight `OPTIONS` requests return `204 No Content`.

---

## Build & Cross-Compilation

```bash
# ARM64 (Raspberry Pi 64-bit, Jetson)
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o plc-agent .

# ARM32 (Raspberry Pi 32-bit)
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -ldflags="-s -w" -o plc-agent .

# x86_64
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o plc-agent .
```

All builds are fully static (no CGO, no libc dependency).
