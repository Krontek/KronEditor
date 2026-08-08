#!/usr/bin/env python3
"""
ring_stream_client.py — KronServer LOSSLESS capture-ring client.

Unlike buffered_stream_client.py (which server-samples at interval_us and aliases
away values faster than that), the capture ring records EVERY kept scan of the
addressed variables and the server adapts the decimation stride to the link, so
what arrives is contiguous by sequence number with explicit loss accounting.

    python3 ring_stream_client.py --host 192.168.0.23 --password krontek

It auto-discovers the payload layout from /api/v1/ring/info, decodes each record
into named variables, verifies sequence continuity, and reports drops + the
effective capture rate. Use --seconds N to stop after N seconds.

Frame wire format (little-endian):
    u32 frame_len        bytes after this field
    u32 record_count
    u32 stride_N         current decimation stride (1 = every scan)
    u64 dropped_total    cumulative overwrite (lap) losses
    record_count × record:
        u64 seq
        u16 task_id
        u16 payload_len
        u8  payload[payload_len]
"""
import argparse, json, struct, sys, time
import urllib.request, urllib.parse

TYPE_FMT = {
    "bool": ("?", 1), "int8": ("b", 1), "uint8": ("B", 1),
    "int16": ("h", 2), "uint16": ("H", 2), "int32": ("i", 4), "uint32": ("I", 4),
    "int64": ("q", 8), "uint64": ("Q", 8), "float32": ("f", 4), "float64": ("d", 8),
}


def auth(base, pw):
    body = json.dumps({"password": pw}).encode()
    req = urllib.request.Request(base + "/api/v1/auth", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)["token"]


def ring_info(base, token):
    req = urllib.request.Request(base + "/api/v1/ring/info",
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def read_exact(resp, n):
    chunks, got = [], 0
    while got < n:
        b = resp.read(n - got)
        if not b:
            return b""
        chunks.append(b); got += len(b)
    return b"".join(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7070)
    ap.add_argument("--password", required=True)
    ap.add_argument("--seconds", type=float, default=5.0, help="stop after N seconds (0 = forever)")
    ap.add_argument("--print-values", action="store_true", help="print each record's decoded values")
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"
    token = auth(base, args.password)
    info = ring_info(base, token)
    if not info.get("available"):
        print("capture ring not available:", info.get("reason", "?")); sys.exit(1)

    # build a per-task decoder from the layout (falls back to header if no layout)
    layout = info.get("layout")
    task_vars = {}   # task_id -> [(name, fmt, size), ...]
    if layout:
        for t in layout.get("tasks", []):
            cols = []
            for v in t.get("vars", []):
                fmt, sz = TYPE_FMT.get(v["type"], ("%ds" % v["size"], v["size"]))
                cols.append((v["name"], fmt, sz))
            task_vars[t["task_id"]] = cols
    print(f"connected. produced≈{info.get('produced_bytes_per_sec',0)/1024:.1f} KB/s, "
          f"record_stride={info.get('record_stride')}, nslots={info.get('nslots')}")
    for t in info.get("header_tasks", []):
        print(f"  task {t['task_id']}: period_us={t['period_us']} payload_len={t['payload_len']}")

    q = urllib.request.Request(base + "/api/v1/stream/ring",
                               headers={"Authorization": "Bearer " + token})
    resp = urllib.request.urlopen(q, timeout=10)

    t0 = time.time()
    total_recs = 0
    gaps = 0
    expect_seq = None
    last_dropped = 0
    last_stride = 1
    last_report = t0
    per_task_last_val = {}
    # The very first frame's `dropped` is the ring history that had already lapped
    # BEFORE we attached (records produced while the runtime ran without us) — that
    # is not a streaming loss. Only drops BEYOND this baseline mean the consumer
    # could not keep up after attaching.
    attach_backlog = None

    try:
        while True:
            if args.seconds and time.time() - t0 > args.seconds:
                break
            head = read_exact(resp, 4)
            if len(head) < 4:
                break
            body = read_exact(resp, struct.unpack("<I", head)[0])
            if not body:
                break
            count, stride_n, dropped = struct.unpack_from("<IIQ", body, 0)
            last_stride, last_dropped = stride_n, dropped
            if attach_backlog is None:
                attach_backlog = dropped
            off = 16
            for _ in range(count):
                seq, task_id, plen = struct.unpack_from("<QHH", body, off)
                payload = body[off + 12: off + 12 + plen]
                off += 12 + plen
                if expect_seq is not None and seq != expect_seq:
                    gaps += 1
                expect_seq = seq + 1
                total_recs += 1
                if args.print_values and task_id in task_vars:
                    vals = {}
                    p = 0
                    for name, fmt, sz in task_vars[task_id]:
                        vals[name] = struct.unpack_from("<" + fmt, payload, p)[0]
                        p += sz
                    print(f"seq={seq} task={task_id} {vals}")

            now = time.time()
            if now - last_report >= 1.0:
                rate = total_recs / (now - t0)
                stream_drops = last_dropped - (attach_backlog or 0)
                print(f"[{now-t0:4.1f}s] records={total_recs} rate={rate:8.0f}/s "
                      f"stride_N={last_stride} streaming_drops={stream_drops} seq_gaps={gaps}")
                last_report = now
    except KeyboardInterrupt:
        pass
    finally:
        resp.close()

    dur = time.time() - t0
    backlog = attach_backlog or 0
    stream_drops = last_dropped - backlog
    print("\n=== SUMMARY ===")
    print(f"duration          {dur:.2f} s")
    print(f"records           {total_recs}  ({total_recs/max(dur,1e-9):.0f}/s)")
    print(f"final stride_N    {last_stride}  (1 = every scan captured; >1 = decimated to fit the link)")
    print(f"attach backlog    {backlog}  (ring history already lapped BEFORE we connected — not a stream loss)")
    print(f"streaming drops   {stream_drops}  (records lost AFTER attach because we couldn't keep up)")
    print(f"seq gaps          {gaps}")
    if gaps == 0 and stream_drops == 0:
        if last_stride == 1:
            print("✅ LOSSLESS: after attach, every scan delivered — no decimation, no drops, no gaps.")
        else:
            print(f"✅ NO LOSS after attach: delivered every {last_stride}th scan (link-limited, "
                  f"uniform decimation), zero drops/gaps.")
    else:
        print("⚠️ records lost during streaming — link slower than production even after decimation; "
              "raise the capture buffer % or reduce the captured variable set / rate.")


if __name__ == "__main__":
    main()
