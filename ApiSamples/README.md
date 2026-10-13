# ApiSamples

Generic, project-agnostic examples for KronServer's external API (`server/API.md`
is the full reference). Everything here is **stdlib only** — no pip installs —
and discovers the deployed variables instead of hardcoding names, so the samples
run against any project that has at least one **addressed** variable.

Defaults are `--host 192.168.1.104 --port 7070 --password krontek`; every script
takes those flags.

| File | What it shows |
|---|---|
| `kron_client.py` | Shared client: auth, read/write, force clear, runtime control, SSE, capture ring. Import it, don't copy it. |
| `01_read_write.py` | Log in, list every addressed variable with type + address, force-write one, release forces. |
| `02_stream_snapshot.py` | `/api/v1/stream` SSE. Reports snapshots/s vs changes/s — the gap is aliasing. |
| `03_ring_capture.py` | `/api/v1/stream/ring` lossless capture, with decimation vs real loss kept apart. Optional CSV. |
| `Onemotorcontrol.py` | Larger tkinter GUI: write-side demo (force-write, runtime start/stop, AutoRun, cadence). |
| `advisor_control.py` | tkinter sliders for the advisor boat project: `%MD52` drive / `%MD56` rudder, -100..+100, with RC-switch status. |
| `ml0_ring_viewer.py` | tkinter viewer for N variables from `%ML0` over the capture ring. |
| `ml0_sequence_check.py` | Correctness trial: does the ring really deliver **every** scan, in order? |
| `test_*.py` | Offline tests of the decoders — synthetic frames, no device needed. |

Quick start:

```bash
python3 01_read_write.py --host 192.168.1.50 --password secret
python3 02_stream_snapshot.py --seconds 10 --interval-ms 5
python3 03_ring_capture.py --seconds 5 --csv capture.csv
python3 -m unittest discover -p 'test_*.py' -v
```

Notes that bite:

- Only variables with an IEC **address** in the editor's Address column are
  visible over REST. Everything else is editor-only.
- An IEC `TIME`/`LTIME` variable is type **`int64`**: signed **microseconds**
  (`T#2h` = `7200000000`, `T#-5s` = `-5000000`), addressed as `%ML`. Beyond
  ±2^53 a REST/SSE value is a decimal string; `kron_client.time_us()` /
  `format_iec_time()` handle both.
- A REST write is a **force** by default: the value is pinned until released.
  Send `{"value": v, "mode": "pulse"}` to write once and let the program own it
  from the same scan, or `"mode": "unforce"` to release one variable (with a
  non-null value, also written once). `POST /api/v1/forces/clear`
  (`01_read_write.py --clear-forces`) releases **every** force on the PLC —
  including ones set from the editor or by another client.
- A write returns **only after the PLC runtime applied it** (force-write
  mailbox, SHM layout v2). `409` = runtime not running, still starting, or a
  runtime/KronServer version mismatch (redeploy KronServer *and* Build & Send);
  `503` = mailbox full; `504` = the runtime did not acknowledge in time — the
  write was **not** applied.
- 64-bit integers (`LINT`/`ULINT`/`LWORD`) beyond ±2^53 must be sent as
  **decimal strings**; Python's `json` keeps them exact either way.
- A `REAL`/`LREAL` holding NaN or ±Inf reads back as JSON `null` (`None`).
- The capture ring needs **two** current pieces on the device — a ring-enabled
  `runtime.bin` (a normal Build & Send) *and* a ring-capable KronServer. A 404
  on `/api/v1/ring/info` means the agent is stale: run `server/build.sh`, then
  Deploy Server to Target.
- The ring is **paused** while no client is streaming, so a fresh connection
  sees data from the moment it attaches — no history. `dropped_total` counts
  from **0 for each connection**, so every unit of it is loss — do **not**
  subtract the first frame's value (older samples did, which hid real loss).
- Binary streams speak **frame format v2** and must be requested with `?v=2`
  (`/api/v1/stream/ring?v=2`, `/api/v1/stream/buffered?v=2`); without it the
  server answers `400` rather than a stream an old decoder would misread.
  Ring frames carry the runtime `epoch` (a change = Build & Send / restart:
  `kron_client` re-fetches `/api/v1/ring/info` itself) and a per-record scan
  counter (consecutive records of a task differ by `stride_n`). The buffered
  stream carries a monotonic timestamp and a `missed` counter per frame, and
  ends when the variable table changes.
