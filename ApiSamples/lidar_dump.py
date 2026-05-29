"""
lidar_dump.py — diagnostic stream printer for KronServer.

Connects to /api/v1/stream and prints %MD20 (angle), %MD21 (distance)
and %MB5 (quality) for every snapshot. Use this to verify that the PLC
is actually writing to the addressed variables. If the editor watch
shows angle moving but this script keeps printing the same value, the
parser is writing to a local-scope variable that doesn't share its
address with the global.

Usage:
    python3 lidar_dump.py                      # uses defaults below
    python3 lidar_dump.py 192.168.1.50         # custom host
    python3 lidar_dump.py 192.168.1.50 7070 mypass
"""

import json
import sys
import time
import urllib.request

HOST     = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.129"
PORT     = sys.argv[2] if len(sys.argv) > 2 else "7070"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "krontek"

ANGLE_ADDR   = "%MD20"
DIST_ADDR    = "%MD21"
QUALITY_ADDR = "%MB5"

BASE = f"http://{HOST}:{PORT}"


def _request(method, path, body=None, token=None, timeout=5):
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"Content-Type": "application/json"}
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE + path, data=data, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def authenticate():
    if not PASSWORD:
        return ""
    return _request("POST", "/api/v1/auth", {"password": PASSWORD}).get("token", "")


def resolve_address(address, token):
    names = _request("GET", "/api/v1/variables", token=token)
    for name in names:
        info = _request("GET", f"/api/v1/variables/{name}", token=token)
        if (info.get("address") or "").upper() == address.upper():
            return name
    return None


def stream(token, a_name, d_name, q_name):
    hdrs = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(BASE + "/api/v1/stream", headers=hdrs)
    last_a = last_d = last_q = None
    last_print = 0.0
    with urllib.request.urlopen(req, timeout=None) as resp:
        buf = ""
        while True:
            chunk = resp.read(1024).decode(errors="replace")
            if not chunk:
                break
            buf += chunk
            while "\n\n" in buf:
                event, buf = buf.split("\n\n", 1)
                for line in event.splitlines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        flat = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    a = flat.get(a_name)
                    d = flat.get(d_name)
                    q = flat.get(q_name)
                    changed = (a != last_a) or (d != last_d) or (q != last_q)
                    now = time.monotonic()
                    # Always print at least once per second so a stuck stream is obvious.
                    if changed or (now - last_print) > 1.0:
                        ts = time.strftime("%H:%M:%S")
                        a_s = "—" if a is None else f"{float(a):7.2f}"
                        d_s = "—" if d is None else f"{float(d):10.2f}"
                        q_s = "—" if q is None else f"{int(q):3d}"
                        flag = "" if changed else "  (no change)"
                        print(f"[{ts}]  angle={a_s}°  dist={d_s}  quality={q_s}{flag}")
                        last_a, last_d, last_q = a, d, q
                        last_print = now


def main():
    print(f"[*] Connecting to {BASE} (password={'yes' if PASSWORD else 'no'})")
    try:
        token = authenticate()
    except Exception as e:
        print(f"[X] Auth failed: {e}")
        sys.exit(1)

    print(f"[*] Enumerating ALL addressed variables (looking for duplicates):")
    names = _request("GET", "/api/v1/variables", token=token)
    matches = {ANGLE_ADDR: [], DIST_ADDR: [], QUALITY_ADDR: []}
    for name in sorted(names.keys()):
        info = _request("GET", f"/api/v1/variables/{name}", token=token)
        addr = (info.get("address") or "").upper()
        if not addr:
            continue
        val = info.get("value")
        print(f"    {addr:<8}  {name:<40}  value={val}")
        if addr in matches:
            matches[addr].append(name)

    print()
    a_name = matches[ANGLE_ADDR][0]   if matches[ANGLE_ADDR]   else None
    d_name = matches[DIST_ADDR][0]    if matches[DIST_ADDR]    else None
    q_name = matches[QUALITY_ADDR][0] if matches[QUALITY_ADDR] else None

    for label, addr, found in [
        ("angle",    ANGLE_ADDR,   matches[ANGLE_ADDR]),
        ("distance", DIST_ADDR,    matches[DIST_ADDR]),
        ("quality",  QUALITY_ADDR, matches[QUALITY_ADDR]),
    ]:
        if len(found) == 0:
            print(f"    [X] {addr} ({label:<8}) → no variable carries this address")
        elif len(found) > 1:
            print(f"    [!] {addr} ({label:<8}) → DUPLICATE: {found}  (using {found[0]})")
        else:
            print(f"    [✓] {addr} ({label:<8}) → {found[0]}")

    if not (a_name and d_name and q_name):
        print(f"\n    Set the missing address(es) on a Global variable + Build & Send.")
        sys.exit(2)
    print(f"[*] Streaming (Ctrl+C to stop)\n")

    try:
        stream(token, a_name, d_name, q_name)
    except KeyboardInterrupt:
        print("\n[*] Stopped")
    except Exception as e:
        print(f"\n[X] Stream error: {e}")
        sys.exit(3)


if __name__ == "__main__":
    main()
