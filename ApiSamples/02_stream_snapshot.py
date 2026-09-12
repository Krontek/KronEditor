#!/usr/bin/env python3
"""
02_stream_snapshot.py — follow the SSE snapshot feed and report what it can
actually deliver.

/api/v1/stream emits ONE snapshot of every addressed variable per tick, at
stream_interval_ms (5..60000, default 50). It is not a packet feed: a variable
that changes faster than the cadence has its intermediate values aliased away.
So this sample prints two different numbers, and the gap between them is the
point:

    snapshots/s   how often the API delivered a frame  (cadence-limited)
    changes/s     how often a variable's value was DIFFERENT from the previous
                  snapshot — an under-estimate of the true update rate, never
                  an over-estimate

If changes/s sits at the snapshot rate, the variable is moving at least that
fast and you are aliasing: use 03_ring_capture.py instead. If it is far below,
you are polling faster than the program publishes.

Usage:
    python3 02_stream_snapshot.py --seconds 10
    python3 02_stream_snapshot.py --interval-ms 5     # ask for the fastest cadence
    python3 02_stream_snapshot.py --print             # dump every snapshot
"""
import argparse
import sys
import time

from kron_client import add_common_args, connect


def main():
    ap = add_common_args(argparse.ArgumentParser(description=__doc__))
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--interval-ms", type=int, default=None,
                    help="set stream_interval_ms before streaming (5..60000)")
    ap.add_argument("--print", dest="dump", action="store_true",
                    help="print every snapshot instead of only the summary")
    args = ap.parse_args()

    client = connect(args)
    if args.interval_ms is not None:
        applied = client.config(stream_interval_ms=args.interval_ms)
        print(f"cadence set to {applied['stream_interval_ms']} ms (server clamps 5..60000)")

    names = sorted(client.variables())
    if not names:
        print("no addressed variables to stream")
        return 1
    print(f"streaming {len(names)} variable(s) for {args.seconds:g} s ...")

    snapshots = 0
    changes = {n: 0 for n in names}
    previous = {}
    started = time.monotonic()

    for snap in client.stream_snapshots(timeout=args.seconds + 10):
        snapshots += 1
        for name, value in snap.items():
            if name in previous and previous[name] != value:
                changes[name] = changes.get(name, 0) + 1
            previous[name] = value
        if args.dump:
            print(snap)
        if time.monotonic() - started >= args.seconds:
            break

    elapsed = time.monotonic() - started
    print(f"\n{snapshots} snapshots in {elapsed:.2f} s = {snapshots / elapsed:.1f}/s")
    print(f"{'variable':<32} {'changes/s':>10}   last value")
    for name in names:
        print(f"{name:<32} {changes.get(name, 0) / elapsed:10.1f}   {previous.get(name)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
