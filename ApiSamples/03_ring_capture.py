#!/usr/bin/env python3
"""
03_ring_capture.py — read EVERY scan from KronServer's lossless capture ring
and account for what (if anything) was lost.

Unlike the SSE feed, the ring's producer is the PLC scan loop itself, so there
is no server-side sampling to alias. Three numbers decide whether a capture is
trustworthy, and this sample reports all three separately because they mean
different things:

    stride_N > 1     the server is DECIMATING to fit the link — every Nth scan,
                     uniformly spaced. Not loss; the effective sample period is
                     task period_us x stride_N.
    seq gaps         records the transport never delivered. This is real loss.
    dropped_total    ring-overwrite loss. The FIRST frame's value is attach
                     backlog (produced before you connected); only later
                     increases mean the consumer could not keep up.

Two things must be current on the device: a ring-enabled runtime (a normal
Build & Send) and a ring-capable KronServer. A 404 on /api/v1/ring/info means
the agent is stale — run server/build.sh, then Deploy Server to Target.

Usage:
    python3 03_ring_capture.py --seconds 5
    python3 03_ring_capture.py --csv capture.csv     # write every scan to CSV
"""
import argparse
import sys
import time

from kron_client import add_common_args, connect


def main():
    ap = add_common_args(argparse.ArgumentParser(description=__doc__))
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--csv", metavar="PATH", help="write one row per captured scan")
    args = ap.parse_args()

    client = connect(args)
    info = client.ring_info()
    if not info.get("available"):
        print(f"capture ring unavailable: {info.get('reason', 'unknown')}")
        print("start the runtime, and make sure it was built with the ring "
              "(a normal Build & Send)")
        return 1

    layout = info["layout"]
    for task in layout["tasks"]:
        names = ", ".join(v["name"] for v in task["vars"])
        print(f"task {task['task_id']}: period {task['period_us']} us -> {names}")
    print(f"ring: {info['nslots']} slots x {info['record_stride']} B, "
          f"producing {info['produced_bytes_per_sec'] / 1e6:.2f} MB/s\n")

    csv = None
    if args.csv:
        csv = open(args.csv, "w")
        header = [v["name"] for t in layout["tasks"] for v in t["vars"]]
        csv.write("seq,task_id," + ",".join(header) + "\n")

    records = gaps = 0
    expected = None
    first_dropped = None
    dropped = 0
    strides = set()
    started = time.monotonic()

    try:
        for frame in client.stream_ring_frames(layout, timeout=args.seconds + 10):
            strides.add(frame["stride_n"])
            if first_dropped is None:
                first_dropped = frame["dropped_total"]   # attach backlog, not loss
            dropped = frame["dropped_total"] - first_dropped
            for seq, task_id, values in frame["records"]:
                if expected is not None and seq != expected:
                    gaps += seq - expected
                expected = seq + 1
                records += 1
                if csv:
                    csv.write(f"{seq},{task_id}," +
                              ",".join(str(v) for v in values.values()) + "\n")
            if time.monotonic() - started >= args.seconds:
                break
    finally:
        if csv:
            csv.close()

    elapsed = time.monotonic() - started
    print(f"{records} records in {elapsed:.2f} s = {records / elapsed:,.0f} scans/s")
    print(f"stride_N seen: {sorted(strides)}"
          f"{'  (decimated — not loss)' if max(strides or [1]) > 1 else ''}")
    print(f"seq gaps: {gaps}   ring-overwrite loss after attach: {dropped}")
    if first_dropped:
        print(f"(attach backlog at connect: {first_dropped} records — expected, ignore)")
    if csv:
        print(f"wrote {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
