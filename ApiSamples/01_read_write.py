#!/usr/bin/env python3
"""
01_read_write.py — the smallest useful KronServer session: log in, list the
addressed variables, read one, write one.

Works against ANY deployed project: it discovers the variables instead of
assuming names or addresses. Only variables carrying an IEC address in the
editor's "Address" column are visible over REST.

Usage:
    python3 01_read_write.py --host 192.168.1.104 --password krontek
    python3 01_read_write.py --write myVar=42       # write once, then read back
"""
import argparse
import sys

from kron_client import add_common_args, connect


def coerce(text):
    """'true' -> True, '42' -> 42, '1.5' -> 1.5, anything else stays a string."""
    low = text.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            pass
    return text


def main():
    ap = add_common_args(argparse.ArgumentParser(description=__doc__))
    ap.add_argument("--write", metavar="NAME=VALUE", action="append", default=[],
                    help="write a variable once (repeatable)")
    args = ap.parse_args()

    client = connect(args)
    print(f"connected to {client.base}")

    rt = client.runtime()
    print(f"runtime: {'RUNNING pid ' + str(rt['pid']) if rt['running'] else 'STOPPED'}"
          f"  auto_run={rt['auto_run']}  stream_interval={rt['stream_interval_ms']} ms")

    variables = client.variables()
    if not variables:
        print("no addressed variables — give a variable an IEC address in the "
              "editor and Build & Send")
        return 1

    print(f"\n{len(variables)} addressed variable(s):")
    for name in sorted(variables):
        meta = client.variable(name)          # adds type + address
        print(f"  {meta['address']:<10} {name:<32} {meta['type']:<8} = {meta['value']}")

    for spec in args.write:
        if "=" not in spec:
            print(f"skipping '{spec}': expected NAME=VALUE", file=sys.stderr)
            continue
        name, _, raw = spec.partition("=")
        value = coerce(raw)
        client.write(name, value)
        # A one-shot write: the program owns the value again from the same
        # scan, so a variable the logic assigns every scan reads back its own
        # value, not the one written.
        print(f"\nwrote {name} = {value!r} -> now {client.variable(name)['value']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
