#!/usr/bin/env python3
"""
lidar_resolution.py — tüm veriyi buffered stream'den al, açısal çözünürlüğü
(derece) hesapla ve polar tarama grafiğini çıkar.

Çözünürlük, YAKALANAN noktalardan değil, lidar_pkt_count (gerçek üretim sayacı)
+ tarama hızından hesaplanır:

    çözünürlük[°] = 360 × tarama_hızı[Hz] / üretim_hızı[nokta/s]

Böylece API 100µs floor'da noktaların bir kısmını atlasa bile GERÇEK çözünürlük
doğru çıkar (aliasing'e dayanıklı). Grafik ise yakalanan tüm noktalardan çizilir.

Kullanım:
    python3 lidar_resolution.py --host 192.168.2.47 --password PAROLA --seconds 10
"""

import argparse
import json
import math
import struct
import sys
import time
import urllib.parse
import urllib.request

TYPE_FMT = {0: ("?", 1), 1: ("b", 1), 2: ("B", 1), 3: ("h", 2), 4: ("H", 2),
            5: ("i", 4), 6: ("I", 4), 7: ("q", 8), 8: ("Q", 8), 9: ("f", 4), 10: ("d", 8)}


def auth(base, password):
    body = json.dumps({"password": password}).encode()
    req = urllib.request.Request(base + "/api/v1/auth", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)["token"]


def read_exact(resp, n):
    out = b""
    while len(out) < n:
        b = resp.read(n - len(out))
        if not b:
            return b""
        out += b
    return out


def stream(base, token, vars_csv, interval_us, seconds):
    q = urllib.parse.urlencode({"vars": vars_csv, "interval_us": interval_us})
    req = urllib.request.Request(base + "/api/v1/stream/buffered?" + q,
                                 headers={"Authorization": "Bearer " + token})
    resp = urllib.request.urlopen(req)
    rows = []           # (angle, dist_mm, pkt)
    t0 = time.time()
    while time.time() - t0 < seconds:
        hdr = read_exact(resp, 4)
        if not hdr:
            break
        (flen,) = struct.unpack("<I", hdr)
        pay = read_exact(resp, flen)
        if len(pay) < flen:
            break
        cnt, vn = struct.unpack_from("<HB", pay, 0)
        types = pay[3:3 + vn]
        fmt = "<" + "".join(TYPE_FMT[t][0] for t in types)
        ssz = struct.calcsize(fmt)
        off = 3 + vn
        for i in range(cnt):
            rows.append(struct.unpack_from(fmt, pay, off + i * ssz))
    resp.close()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7070)
    ap.add_argument("--password", required=True)
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--interval-us", type=int, default=100, help="100 = tüm veri (server floor)")
    ap.add_argument("--angle-var", default="prog_lidar_receive_lidar_angle")
    ap.add_argument("--dist-var", default="prog_lidar_receive_lidar_distance")
    ap.add_argument("--pkt-var", default="prog_lidar_receive_lidar_pkt_count")
    ap.add_argument("--png", default="lidar_scan.png")
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"
    token = auth(base, args.password)
    order = [args.angle_var, args.dist_var, args.pkt_var]
    print(f"[i] {args.seconds:.0f}s stream @ interval_us={args.interval_us} …")
    rows = stream(base, token, ",".join(order), args.interval_us, args.seconds)
    if len(rows) < 10:
        sys.exit("[!] veri yok/az — şifre/değişken adı/lidar üretimi kontrol et")

    angles = [r[0] for r in rows]
    dists = [r[1] for r in rows]
    pkts = [int(r[2]) for r in rows]
    dur = args.seconds

    # üretim hızı (pkt_count delta) — GERÇEK nokta/s
    prod = pkts[-1] - pkts[0]
    prod_rate = prod / dur if dur > 0 else 0

    # tarama hızı: açı sarma (360→0) sayısı
    revs = 0
    prev = angles[0]
    for a in angles[1:]:
        if a + 180.0 < prev:   # büyük geri sıçrama = yeni tur
            revs += 1
        prev = a
    scan_hz = revs / dur if dur > 0 and revs > 0 else float("nan")

    pts_per_rev = prod_rate / scan_hz if scan_hz and scan_hz == scan_hz else float("nan")
    res_deg = 360.0 / pts_per_rev if pts_per_rev and pts_per_rev == pts_per_rev else float("nan")

    print()
    print("=" * 44)
    print(f"  AÇISAL ÇÖZÜNÜRLÜK : {res_deg:.3f}°")
    print("=" * 44)
    print(f"  tarama hızı       : {scan_hz:.2f} Hz  ({scan_hz*60:.0f} RPM)")
    print(f"  üretim hızı       : {prod_rate:.0f} nokta/s   [pkt_count]")
    print(f"  nokta / tur       : {pts_per_rev:.0f}")
    print(f"  yakalanan örnek   : {len(rows)}  ({len(rows)/dur:.0f}/s)")
    print("=" * 44)

    # polar grafik (yakalanan tüm noktalar)
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        th = [math.radians(a) for a, d in zip(angles, dists) if d > 0]
        r = [d / 1000.0 for d in dists if d > 0]
        fig = plt.figure(figsize=(7, 7))
        ax = fig.add_subplot(111, projection="polar")
        ax.set_theta_zero_location("N")
        ax.set_theta_direction(-1)
        ax.scatter(th, r, s=2, c=r, cmap="viridis")
        ax.set_title(f"Lidar taraması — çözünürlük {res_deg:.3f}°  ({scan_hz:.1f} Hz)")
        fig.savefig(args.png, dpi=120, bbox_inches="tight")
        print(f"[i] grafik: {args.png}  ({len(r)} nokta)")
    except ImportError:
        print("[i] matplotlib yok → grafik atlandı (pip install matplotlib)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
