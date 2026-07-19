#!/usr/bin/env python3
"""
buffered_stream_client.py — KronServer buffered BINARY stream client.

Delivery is fixed at 5 ms; you pick a sample interval (interval_us). If it is
shorter than 5 ms, the server buffers and each 5 ms frame carries ~5000/interval_us
samples. Samples are assumed evenly spaced by interval_us (no timestamps).

Usage:
    python3 buffered_stream_client.py --host 192.168.2.47 --password YOURPASS \
        --vars prog__lidar_dist,prog__lidar_angle --interval-us 1000

Frame wire format (little-endian):
    u32 frame_len        bytes after this field
    u16 sample_count
    u8  var_count
    u8  types[var_count]
    sample_count × ( each var's native value, in request order )
"""

import argparse
import struct
import sys
import urllib.request
import urllib.parse
import json

# type code -> (struct format char, size bytes)
TYPE_FMT = {
    0: ("?", 1),  # bool
    1: ("b", 1),  # int8
    2: ("B", 1),  # uint8
    3: ("h", 2),  # int16
    4: ("H", 2),  # uint16
    5: ("i", 4),  # int32
    6: ("I", 4),  # uint32
    7: ("q", 8),  # int64
    8: ("Q", 8),  # uint64
    9: ("f", 4),  # float32
    10: ("d", 8), # float64
}


def auth(base, password):
    body = json.dumps({"password": password}).encode()
    req = urllib.request.Request(base + "/api/v1/auth", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)["token"]


def read_exact(resp, n):
    """Read exactly n bytes from the streaming response, or b'' on EOF."""
    chunks = []
    got = 0
    while got < n:
        b = resp.read(n - got)
        if not b:
            return b""
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7070)
    ap.add_argument("--password", required=True)
    ap.add_argument("--vars", required=True, help="comma-separated addressed variable names")
    ap.add_argument("--interval-us", type=int, default=1000)
    ap.add_argument("--max-frames", type=int, default=0, help="stop after N frames (0 = forever)")
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"
    token = auth(base, args.password)

    q = urllib.parse.urlencode({"vars": args.vars, "interval_us": args.interval_us})
    req = urllib.request.Request(base + "/api/v1/stream/buffered?" + q,
                                 headers={"Authorization": "Bearer " + token})
    resp = urllib.request.urlopen(req)  # streaming, no timeout

    frames = 0
    total_samples = 0
    while True:
        hdr = read_exact(resp, 4)
        if not hdr:
            print("stream closed")
            break
        (frame_len,) = struct.unpack("<I", hdr)
        payload = read_exact(resp, frame_len)
        if len(payload) < frame_len:
            print("truncated frame")
            break

        sample_count, var_count = struct.unpack_from("<HB", payload, 0)
        off = 3
        types = payload[off:off + var_count]
        off += var_count

        fmts = [TYPE_FMT[t] for t in types]
        bytes_per_sample = sum(sz for _, sz in fmts)
        struct_fmt = "<" + "".join(fc for fc, _ in fmts)
        sample_size = struct.calcsize(struct_fmt)

        samples = []
        for i in range(sample_count):
            vals = struct.unpack_from(struct_fmt, payload, off + i * sample_size)
            samples.append(vals)
        off += sample_count * sample_size

        frames += 1
        total_samples += sample_count
        # Show first frame layout + a summary each frame.
        print(f"frame {frames}: {sample_count} samples x {var_count} vars "
              f"({bytes_per_sample} B/sample)  first={samples[0]}  last={samples[-1]}")

        if args.max_frames and frames >= args.max_frames:
            break

    print(f"done: {frames} frames, {total_samples} samples")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
