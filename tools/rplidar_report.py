#!/usr/bin/env python3
"""
rplidar_report.py — pull ALL lidar data from the KronServer buffered BINARY
stream and summarize the sensor (resolution, scan rate, range, coverage).

The lidar is read on the target by the PLC (lidar_receive) and exposed as
addressed variables. This tool streams angle/distance/quality at a high sample
rate via /api/v1/stream/buffered, collects the whole dataset over a window, and
reports it. It also streams lidar_pkt_count so it can report the CAPTURE RATIO
(points the lidar produced vs points this tool actually captured) — i.e. whether
you are really getting "all the data".

Usage:
    python3 rplidar_report.py --host 192.168.2.47 --password YOURPASS --seconds 15

Outputs:
    lidar_log.csv     — every captured sample (t_s, angle_deg, dist_mm, quality, pkt)
    lidar_report.txt  — the summary below (also printed)
"""

import argparse
import csv
import json
import struct
import statistics
import sys
import time
import urllib.parse
import urllib.request

# buffered-stream type code -> (struct char, size)
TYPE_FMT = {
    0: ("?", 1), 1: ("b", 1), 2: ("B", 1), 3: ("h", 2), 4: ("H", 2),
    5: ("i", 4), 6: ("I", 4), 7: ("q", 8), 8: ("Q", 8), 9: ("f", 4), 10: ("d", 8),
}


def auth(base, password):
    body = json.dumps({"password": password}).encode()
    req = urllib.request.Request(base + "/api/v1/auth", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)["token"]


def read_exact(resp, n):
    chunks, got = [], 0
    while got < n:
        b = resp.read(n - got)
        if not b:
            return b""
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def collect(base, token, vars_csv, interval_us, seconds):
    """Stream the buffered feed and return a list of per-sample tuples plus the
    request-order variable list. Samples are timestamped assuming even spacing
    (interval_us) within each frame."""
    q = urllib.parse.urlencode({"vars": vars_csv, "interval_us": interval_us})
    req = urllib.request.Request(base + "/api/v1/stream/buffered?" + q,
                                 headers={"Authorization": "Bearer " + token})
    resp = urllib.request.urlopen(req)

    samples = []
    t0 = time.time()
    step = interval_us / 1e6
    while time.time() - t0 < seconds:
        hdr = read_exact(resp, 4)
        if not hdr:
            break
        (frame_len,) = struct.unpack("<I", hdr)
        payload = read_exact(resp, frame_len)
        if len(payload) < frame_len:
            break
        count, var_n = struct.unpack_from("<HB", payload, 0)
        off = 3
        types = payload[off:off + var_n]
        off += var_n
        fmt = "<" + "".join(TYPE_FMT[t][0] for t in types)
        ssz = struct.calcsize(fmt)
        frame_wall = time.time() - t0
        base_t = frame_wall - count * step
        for i in range(count):
            vals = struct.unpack_from(fmt, payload, off + i * ssz)
            samples.append((base_t + i * step,) + vals)
    resp.close()
    return samples


def wrap_diff(a, b):
    """Forward angular distance a->b in degrees (0..360)."""
    d = (b - a) % 360.0
    return d


def main():
    ap = argparse.ArgumentParser(description="Analyze lidar via KronServer buffered stream")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7070)
    ap.add_argument("--password", required=True)
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--interval-us", type=int, default=100, help="sample interval (server floor 100us)")
    ap.add_argument("--angle-var", default="prog_lidar_receive_lidar_angle")
    ap.add_argument("--dist-var", default="prog_lidar_receive_lidar_distance")
    ap.add_argument("--quality-var", default="prog_lidar_receive_lidar_quality")
    ap.add_argument("--pkt-var", default="prog_lidar_receive_lidar_pkt_count")
    ap.add_argument("--no-dedup", action="store_true", help="keep consecutive duplicate points")
    ap.add_argument("--csv", default="lidar_log.csv")
    ap.add_argument("--report", default="lidar_report.txt")
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"
    token = auth(base, args.password)

    vars_order = [args.angle_var, args.dist_var, args.quality_var, args.pkt_var]
    print(f"[i] streaming {args.seconds:.0f}s @ interval_us={args.interval_us} …")
    raw = collect(base, token, ",".join(vars_order), args.interval_us, args.seconds)
    if not raw:
        sys.exit("[!] no samples — check password / variable names / that the lidar is producing")

    # raw sample = (t, angle, dist, quality, pkt)
    dur = raw[-1][0] - raw[0][0] if len(raw) > 1 else args.seconds

    # Distinct points: drop consecutive duplicates (same angle+dist re-sampled by
    # the faster sampler). This yields the actual points captured off the lidar.
    pts = []
    for s in raw:
        if args.no_dedup or not pts or (s[1], s[2]) != (pts[-1][1], pts[-1][2]):
            pts.append(s)

    # Production (from pkt_count delta) vs captured distinct points → capture ratio.
    pkt_first, pkt_last = raw[0][4], raw[-1][4]
    produced = int(pkt_last - pkt_first)
    captured = len(pts)
    prod_rate = produced / dur if dur > 0 else 0
    capt_rate = captured / dur if dur > 0 else 0

    # Revolutions via angle wrap (a big backward jump = new rev).
    revs = 0
    rev_pts = []
    cur = 0
    prev_angle = pts[0][1]
    for s in pts[1:]:
        a = s[1]
        # a rev boundary when angle wraps down past 0 (e.g. 359 -> 3)
        if a + 180.0 < prev_angle:   # large backward step
            revs += 1
            rev_pts.append(cur)
            cur = 0
        cur += 1
        prev_angle = a
    if cur:
        rev_pts.append(cur)

    scan_hz = revs / dur if dur > 0 and revs > 0 else float("nan")
    ppr = statistics.mean(rev_pts) if rev_pts else float("nan")

    # Angular resolution: median forward step between consecutive captured points
    # (ignoring the wrap jumps).
    steps = []
    for i in range(1, len(pts)):
        d = wrap_diff(pts[i - 1][1], pts[i][1])
        if 0 < d < 180:
            steps.append(d)
    res_step = statistics.median(steps) if steps else float("nan")
    max_gap = max(steps) if steps else float("nan")
    res_div = 360.0 / ppr if ppr and ppr == ppr else float("nan")

    dists = [s[2] for s in pts]
    valid = sorted(d for d in dists if d > 0.0)
    valid_ratio = 100.0 * len(valid) / len(pts)
    quals = [s[3] for s in pts]

    def pct(v, p):
        if not v:
            return float("nan")
        k = max(0, min(len(v) - 1, int(round(p / 100.0 * (len(v) - 1)))))
        return v[k]

    # CSV
    with open(args.csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t_s", "angle_deg", "dist_mm", "quality", "pkt"])
        w.writerows(pts)

    L = []
    def p(s=""):
        L.append(s)

    p("=" * 60)
    p("  RPLIDAR RAPORU  (KronServer buffered stream)")
    p("=" * 60)
    p(f"Zaman            : {time.strftime('%Y-%m-%d %H:%M:%S')}")
    p(f"Kaynak           : {base}  vars={','.join(v.split('_')[-1] for v in vars_order[:3])}")
    p(f"Örnekleme        : interval_us={args.interval_us}  (~{1e6/args.interval_us:.0f} Hz)")
    p(f"Süre             : {dur:.2f} s")
    p("")
    p("-- Veri bütünlüğü (TÜM data alınıyor mu?) --")
    p(f"Lidar üretimi    : {produced} nokta  ({prod_rate:.0f}/s)   [pkt_count delta]")
    p(f"Yakalanan (distinct): {captured} nokta  ({capt_rate:.0f}/s)")
    p(f"Ham örnek        : {len(raw)}  (tekrarlar dahil)")
    if produced > 0:
        ratio = 100.0 * captured / produced
        p(f"YAKALAMA ORANI   : {ratio:.1f}%   " +
          ("→ tüm data alınıyor" if ratio >= 98 else
           f"→ ~%{100-ratio:.0f} aliasing kaybı (interval_us'u küçült / server floor'u düşür)"))
    p("")
    p("-- Tarama --")
    p(f"Tur (revolution) : {revs}")
    p(f"Tarama hızı      : {scan_hz:.2f} Hz   ({scan_hz*60:.0f} RPM)")
    p(f"Nokta / tur      : ort {ppr:.0f}" + (f"  (min {min(rev_pts)}, max {max(rev_pts)})" if rev_pts else ""))
    p("")
    p("-- Açısal çözünürlük (yakalanan) --")
    p(f"Ardışık fark medyanı: {res_step:.3f}°")
    p(f"360 / nokta         : {res_div:.3f}°")
    p(f"En büyük boşluk     : {max_gap:.2f}°")
    p("")
    p("-- Menzil (geçerli, mesafe>0) --")
    p(f"Geçerli oran     : {valid_ratio:.1f}%  ({len(valid)}/{len(pts)})")
    if valid:
        p(f"Min / Max        : {valid[0]/1000:.3f} m  /  {valid[-1]/1000:.3f} m")
        p(f"Ort / Medyan     : {statistics.mean(valid)/1000:.3f} m  /  {statistics.median(valid)/1000:.3f} m")
        p(f"5% / 95%         : {pct(valid,5)/1000:.3f} m  /  {pct(valid,95)/1000:.3f} m")
    p("")
    p("-- Sinyal kalitesi --")
    p(f"Kalite ort/medyan: {statistics.mean(quals):.1f} / {statistics.median(quals):.0f}")
    p(f"Kalite min/max   : {min(quals)} / {max(quals)}")
    p("=" * 60)
    p(f"Ham log: {args.csv}  ({len(pts)} distinct nokta)")

    report = "\n".join(L)
    print("\n" + report)
    with open(args.report, "w") as f:
        f.write(report + "\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
