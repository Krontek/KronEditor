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
- A REST write is a **force**: the value is pinned until
  `POST /api/v1/forces/clear` (`01_read_write.py --clear-forces`).
- The capture ring needs **two** current pieces on the device — a ring-enabled
  `runtime.bin` (a normal Build & Send) *and* a ring-capable KronServer. A 404
  on `/api/v1/ring/info` means the agent is stale: run `server/build.sh`, then
  Deploy Server to Target.
- The ring is **paused** while no client is streaming, so a fresh connection
  sees data from the moment it attaches — no history, and the first frame's
  `dropped_total` is attach backlog rather than loss.
