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

### Capture Ring Layout (`ring`)

When the project has addressed scalar variables, the transpiler also emits an optional top-level `ring` object describing the capture-ring record layout. Clients of `GET /api/v1/stream/ring` use it to decode raw record payloads (see [High-Rate Lossless Capture](#high-rate-lossless-capture-capture-ring)). It is served back verbatim by `GET /api/v1/ring/info` under `layout`.

```json
"ring": {
  "record_stride": 96,
  "tasks": [
    { "task_id": 0, "period_us": 100,
      "vars": [
        { "name": "prog_Program0_var1", "type": "int64", "size": 8 },
        { "name": "prog_Program0_var2", "type": "int64", "size": 8 }
      ] }
  ]
}
```

The `vars` order **is** the byte order inside each record's payload for that task.

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

## High-Rate Lossless Capture (Capture Ring)

`/api/v1/stream` (SSE) and the single-value polls return only the **latest** value at each tick, so a variable that changes faster than the cadence (e.g. a 100 µs / 10 kHz task) has its intermediate scans aliased away. The **capture ring** delivers **every scan** of the addressed variables, with explicit loss accounting.

**How it works.** The PLC runtime itself appends each kept scan's addressed-variable values into a second shared-memory segment (`/dev/shm/<shm-name>_ring`) — the real-time scan loop is the producer, so there is no server-side sampling to alias. KronServer drains it in sequence order and pushes it as a compact binary feed every 5 ms. When production outruns the delivery link, the server **uniformly decimates** (keeps every Nth scan, the *same ratio* across all tasks) so the ring never overflows; genuine loss (ring overwrite) is counted and reported, never silent.

**Paused when idle.** While **no** client is streaming, the producer is **paused** (`stride_N = 0` — the runtime writes nothing to the ring, so it burns no scan cycles and stops filling RAM). It resumes automatically on the first `GET /api/v1/stream/ring` connect. Consequently a freshly-connected client sees data building **from the moment it connects**, not history from before — there is a brief (sub-second) warm-up, and the first frame's `dropped_total` is typically 0.

> ⚠️ **Two things must be current on the device, deployed separately:**
> 1. A **ring-enabled runtime** (`runtime.bin` from a Build & Send) — the producer. Symptom if missing: `/api/v1/ring/info` returns `{"available": false}` while `/dev/shm/<shm>_ring` is absent.
> 2. A **ring-capable KronServer** (`plc-agent`) — the endpoints below. Symptom if the agent is an older build: `/api/v1/ring/info` and `/api/v1/stream/ring` return **404**.
>
> Only **addressed scalar** variables are captured (arrays/structs/strings excluded). Globals are sampled at the fastest task's rate.

---

### `GET /api/v1/ring/info`

Returns the live ring header plus the payload layout a client needs to decode `stream/ring` frames.

**Request:**
```http
GET /api/v1/ring/info
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "available": true,
  "record_stride": 24,
  "nslots": 43680,
  "stride_n": 1,
  "write_seq": 1234567,
  "produced_bytes_per_sec": 800000,
  "header_tasks": [
    { "task_id": 0, "period_us": 100, "payload_len": 8 }
  ],
  "layout": {
    "record_stride": 24,
    "tasks": [
      { "task_id": 0, "period_us": 100,
        "vars": [ { "name": "prog_Program0_var1", "type": "int64", "size": 8 } ] }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `available` | `false` (+ `reason`) if the ring segment is absent/uninitialised (runtime not started, or no addressed vars) |
| `record_stride` | Bytes per record slot in the ring (from the live header) |
| `nslots` | Number of record slots (ring capacity) |
| `stride_n` | Current decimation stride — `0` = **paused** (no consumer connected → producer not writing), `1` = every scan, `N` = every Nth scan |
| `write_seq` | Monotonic count of records the producer has written so far |
| `produced_bytes_per_sec` | Raw production rate before decimation (Σ payload_len / period_us) |
| `header_tasks` | Per-task period + payload length, from the ring header |
| `layout.tasks[].vars` | **Ordered** list of variables in each task's record payload — decode payload bytes in this order using each var's `type`/`size` |

> The `layout` comes from the deployed `variable_table.json` (`ring` section) and is the key to decoding: within a record for `task_id`, the payload is the concatenation of that task's `vars` in listed order.

---

### `GET /api/v1/stream/ring`

Binary stream. One frame every 5 ms that carries **all records captured since the previous frame** (so a single frame may contain many scans). Little-endian throughout.

**Request:**
```http
GET /api/v1/stream/ring
Authorization: Bearer <token>
```

**Frame format:**
```
u32  frame_len        bytes following this field
u32  record_count
u32  stride_N         current decimation (1 = every scan)
u64  dropped_total    cumulative ring-overwrite losses since stream start
record_count × record:
    u64  seq          global monotonic sequence number
    u16  task_id      which task wrote it (index into layout.tasks)
    u16  payload_len  valid payload bytes
    u8   payload[payload_len]   task's addressed vars, in layout order
```

**Decoding a record:** look up `task_id` in `layout.tasks`; walk that task's `vars` in order, slicing `size` bytes each from `payload` and decoding by `type` (little-endian). `seq` is globally contiguous across all tasks — a gap in `seq` between consecutive delivered records means records were lost.

**Loss accounting (important):**
- `dropped_total` is cumulative ring-overwrite loss. The **first frame's** `dropped_total` is the "attach backlog" — records produced *before* the client connected that had already lapped out of the ring; this is **not** a streaming loss. Only increases in `dropped_total` *after* the first frame mean the consumer could not keep up.
- `seq` gaps in the delivered stream indicate true loss (should be zero unless the link is saturated even after decimation).
- `stride_N > 1` means the server is decimating to fit the link — you are getting every Nth scan, uniformly spaced, losslessly. Effective sample period ≈ `task period_us × stride_N`.

**Reference client:** `tools/ring_stream_client.py` (reassembles by seq, reports attach-backlog vs streaming drops) and the tkinter viewer `ApiSamples/ml0_ring_viewer.py`.

**Usage (Python):**
```python
import json, struct, urllib.request

base = "http://plc:7070"
tok = json.load(urllib.request.urlopen(urllib.request.Request(
    base + "/api/v1/auth",
    data=json.dumps({"password": "secret"}).encode(),
    headers={"Content-Type": "application/json"})))["token"]

info = json.load(urllib.request.urlopen(urllib.request.Request(
    base + "/api/v1/ring/info", headers={"Authorization": "Bearer " + tok})))
# build a per-task decoder: task_id -> [(name, struct_fmt, size), ...]
FMT = {"bool":"?","int8":"b","uint8":"B","int16":"h","uint16":"H","int32":"i",
       "uint32":"I","int64":"q","uint64":"Q","float32":"f","float64":"d"}
tasks = {t["task_id"]: [(v["name"], FMT[v["type"]], v["size"]) for v in t["vars"]]
         for t in info["layout"]["tasks"]}

resp = urllib.request.urlopen(urllib.request.Request(
    base + "/api/v1/stream/ring", headers={"Authorization": "Bearer " + tok}))

def read_exact(n):
    b = b""
    while len(b) < n:
        c = resp.read(n - len(b))
        if not c: return b
        b += c
    return b

expect = None
while True:
    body = read_exact(struct.unpack("<I", read_exact(4))[0])
    count, stride_n, dropped = struct.unpack_from("<IIQ", body, 0)
    off = 16
    for _ in range(count):
        seq, task_id, plen = struct.unpack_from("<QHH", body, off)
        payload = body[off+12:off+12+plen]; off += 12 + plen
        if expect is not None and seq != expect:
            print("LOSS: seq gap", expect, "->", seq)
        expect = seq + 1
        p, values = 0, {}
        for name, fmt, size in tasks[task_id]:
            values[name] = struct.unpack_from("<" + fmt, payload, p)[0]; p += size
        # values = {var_name: value} for this scan
```

---

### Capture buffer sizing (`ring_ram_percent`)

The ring segment is sized as a percentage of the device's **available** RAM. It is `/dev/shm` (tmpfs, demand-paged), so a large ring only costs RSS as it actually fills.

- Set via `POST /deploy/config` or `POST /api/v1/runtime/config` with `{"ring_ram_percent": <0–50>}`. **Takes effect on the next runtime (re)start.**
- `0` (unset) = the default **50%** of available RAM.
- Clamped to `[64 KiB, min(2 GiB, 50% of available)]`.
- Current sizing and device memory are reported by `GET /status` (`mem_total_bytes`, `mem_available_bytes`, `ring_ram_percent`, `ring_bytes`).

> Sizing the ring only buys **burst headroom** — if production exceeds the delivery link *sustainably*, no buffer size prevents loss; the server decimates (`stride_N`) instead. Pick the ring big enough to absorb consumer stalls (GC pauses, link hiccups), not to "store minutes of data".

---

### Compared to `/api/v1/stream/buffered`

An older `GET /api/v1/stream/buffered?vars=a,b&interval_us=N` endpoint also exists. It **server-samples** at `interval_us` (a Go ticker, ~1–1.5 kHz ceiling on an SBC) and packs samples into 5 ms frames. It is simpler but **aliases** values faster than it can sample, and has no loss accounting. Prefer `/api/v1/stream/ring` when you need every scan; use `buffered` only for modest rates where a fixed sample interval is acceptable.

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
| `ring_ram_percent` | number | yes | Capture-ring size as % of available RAM (0–50; 0 = default 50%). Applies on the next runtime (re)start |

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
| `ring_ram_percent` | number | yes | Capture-ring size as % of available RAM (0–50; 0 = default 50%); applies on the next runtime (re)start |

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
  "stream_interval_ms": 50,
  "mem_total_bytes": 7978577920,
  "mem_available_bytes": 7593451520,
  "ring_ram_percent": 50,
  "ring_bytes": 2134614016
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
| `mem_total_bytes` | int | Device total RAM (from `/proc/meminfo`) |
| `mem_available_bytes` | int | Device available RAM |
| `ring_ram_percent` | number | Effective capture-ring size as % of available RAM (default 50) |
| `ring_bytes` | int | Resolved capture-ring byte size the next runtime start will use |

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
  "stream_interval_ms": 100,
  "ring_ram_percent": 50
}
```

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `auto_run` | bool | `false` | Start `runtime.bin` automatically when the agent boots |
| `stream_interval_ms` | uint | `50` | `/api/v1/stream` cadence (clamped 5–60000); editor streams ignore it |
| `ring_ram_percent` | number | `0` (→50%) | Capture-ring size as % of available RAM; applied when the runtime (re)starts |

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
   GET /api/v1/stream           ← external clients (addressed only, tunable cadence, latest value)
   GET /api/v1/ring/info        ← discover capture-ring layout (for high-rate capture)
   GET /api/v1/stream/ring      ← external clients: EVERY scan of addressed vars, lossless

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
