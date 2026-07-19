"""
lidar_analysis.py — Lidar sampling & sensor characterisation (API sample)
=========================================================================
Measures what the KronServer REST API can actually deliver from a lidar
running on the PLC, then characterises the sensor itself from what it
captured. Complements the other two samples:

  - Onemotorcontrol.py  → writes (force-write, runtime start/stop).
  - lidarsampling.py    → live polar viewer, server cadence control.
  - lidar_analysis.py   → offline measurement + technical plots.

THE THROUGHPUT CEILING (measured, not assumed)
----------------------------------------------
`/api/v1/stream` is a *snapshot* feed, not a packet feed. Each tick it
calls ReadAddressedVariables() and emits whatever is in shared memory at
that instant — one beam. Three limits stack up, and the slowest wins:

  1. API cadence  — stream_interval_ms is clamped to 5..60000 ms by
     SetAPIStreamIntervalMs (server/service.go), so the hard ceiling is
     **200 snapshots/s = 200 beams/s**. There is no batching: a snapshot
     can never carry more than one beam.
  2. PLC task period — the ST driver writes lidar_angle/lidar_distance
     once per scan. A 10 ms task publishes at most 100 new beams/s no
     matter how fast you poll.
  3. Sensor output — an RPLIDAR A1M8 emits ~2000-8000 samples/s.

So the API sees single-digit percent of the beams the sensor produces.
That is not a bug to fix, it is the shape of the interface: shared memory
holds one current beam, and you sample it. This script MEASURES the real
ratio on your setup instead of guessing, then tells you what angular
resolution that ratio actually buys you.

WHAT IT ANALYSES AND WHY
------------------------
  Throughput   achieved snapshot rate vs configured interval — finds the
               knee where polling faster stops helping (limit 1 vs 2).
  Yield        fraction of snapshots carrying a NEW beam. Low yield =
               you are polling faster than the PLC publishes (wasted
               requests). High yield + low capture ratio = the PLC is
               publishing faster than the API can drain (aliasing).
  Resolution   distribution of angular gaps between consecutive captured
               beams. The median gap IS your effective angular
               resolution — compare against the sensor's native
               360°/(samples per revolution).
  Coverage     how long until every angular sector has been visited at
               least once. This is the real latency of "I have a map".
  Sensitivity  return quality vs distance, and dropout rate (distance=0,
               i.e. no return) vs distance. This is the sensor's range
               falloff curve — where it stops seeing things.
  Precision    per-sector distance standard deviation against a STATIC
               scene = repeatability/jitter, plotted against distance.
               Noise grows with range; this shows how fast.

  ⚠️ Precision and dropout-vs-distance are only meaningful if NOTHING
  MOVES during the capture (no people walking past, sensor fixed). A
  moving scene inflates jitter and invalidates that panel.

Project requirements — GLOBAL variables in KronEditor at these addresses
(identical to lidarsampling.py; the ST driver `lidar.st` writes them):

  lidar_angle      REAL   %MD20   beam angle in degrees (0 = forward, CW)
  lidar_distance   REAL   %MD21   beam distance in mm
  lidar_quality    USINT  %MB5    signal strength (0..63 raw)

Strongly recommended (unlocks true-rate + capture-ratio analysis):

  lidar_pkt_count  UDINT  %MD22   per-sample counter — the ONLY way to
                                  know the sensor's real output rate

Usage:
    python3 lidar_analysis.py                          # full run, defaults
    python3 lidar_analysis.py --host 192.168.1.50

  Poll cadence is yours to pick. --interval sets the characterisation
  capture's stream_interval_ms; --sweep sets which cadences the throughput
  sweep probes. Both are validated against the server's 5..60000 ms clamp
  and rejected up front rather than being silently clamped:

    python3 lidar_analysis.py --interval 5             # 200 Hz, the ceiling
    python3 lidar_analysis.py --interval 100           # 10 Hz, gentle on the PLC
    python3 lidar_analysis.py --sweep 5,10,25,100      # custom sweep points
    python3 lidar_analysis.py --sweep 5,20 --sweep-seconds 15   # fewer, longer

    python3 lidar_analysis.py --no-sweep --capture 60  # skip sweep, long capture
    python3 lidar_analysis.py --replay capture.csv     # offline re-analysis
    python3 lidar_analysis.py --out-dir ./results

Requires: numpy, matplotlib.
"""

import argparse
import csv
import json
import math
import statistics
import sys
import time
import urllib.request
from dataclasses import dataclass

import numpy as np

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap


# ── Addresses ─────────────────────────────────────────────────────────────────
ANGLE_ADDR     = "%MD20"
DIST_ADDR      = "%MD21"
QUALITY_ADDR   = "%MB5"
PKT_COUNT_ADDR = "%MD22"

REQ_ADDRESSES = (ANGLE_ADDR, DIST_ADDR, QUALITY_ADDR)
OPT_ADDRESSES = (PKT_COUNT_ADDR,)

# The RPLIDAR protocol emits distance in mm; multiply to get meters. If your
# PLC pre-converts to meters, set this to 1.0. (Same knob as lidarsampling.py.)
DIST_SCALE_TO_M = 0.001

# Raw RPLIDAR quality is 0..63. Used to normalise the sensitivity axis.
QUALITY_MAX = 63

# Server clamp, from SetAPIStreamIntervalMs in server/service.go. The sweep
# refuses to request anything outside this — the server would silently clamp
# and the plotted "configured" axis would be a lie.
MIN_INTERVAL_MS = 5
MAX_INTERVAL_MS = 60000

# Intervals probed by the throughput sweep, fastest first.
SWEEP_INTERVALS_MS = (5, 10, 20, 50, 100, 200)
SWEEP_SECONDS      = 6.0

CAPTURE_SECONDS    = 30.0
ANALYSIS_INTERVAL_MS = 5      # cadence for the long characterisation capture

# 360° is divided into this many sectors for coverage/jitter statistics.
# 1° sectors: coarse enough that a static scene puts many samples in each
# bin (so the std-dev is meaningful), fine enough to show range structure.
ANGLE_SECTORS = 360

# A sector needs at least this many samples before its std-dev is trusted.
MIN_SAMPLES_FOR_JITTER = 8


# ── Theme (validated categorical palette, dark surface #1a1a19) ───────────────
SURFACE   = "#1a1a19"
PANEL     = "#211f1e"
GRID      = "#3a3a38"
TEXT      = "#ffffff"
TEXT_DIM  = "#c3c2b7"
TEXT_MUTE = "#8a8880"

# Categorical slots — fixed order, never cycled. Validated for dark surface:
# CVD separation, normal-vision floor, chroma, lightness band, contrast.
S1_BLUE    = "#3987e5"
S2_GREEN   = "#008300"
S3_MAGENTA = "#d55181"
S4_YELLOW  = "#c98500"
S5_VIOLET  = "#9085e9"

# Sequential ramp (single hue, monotonic lightness) for magnitude encoding.
SEQ_BLUE = LinearSegmentedColormap.from_list(
    "seq_blue", ["#10304f", "#1c5591", "#2f7ccb", "#6fb3ff"]
)


def _style():
    plt.rcParams.update({
        "figure.facecolor":  SURFACE,
        "axes.facecolor":    PANEL,
        "savefig.facecolor": SURFACE,
        "axes.edgecolor":    GRID,
        "axes.labelcolor":   TEXT_DIM,
        "axes.titlecolor":   TEXT,
        "text.color":        TEXT,
        "xtick.color":       TEXT_MUTE,
        "ytick.color":       TEXT_MUTE,
        "grid.color":        GRID,
        "grid.linewidth":    0.6,
        "grid.alpha":        0.5,
        "font.family":       "monospace",
        "font.size":         8.5,
        "axes.titlesize":    10,
        "axes.titleweight":  "bold",
        "axes.spines.top":   False,
        "axes.spines.right": False,
        "legend.frameon":    False,
        "legend.labelcolor": TEXT_DIM,
        "figure.constrained_layout.use": True,
    })


# ── API client ────────────────────────────────────────────────────────────────

class KronClient:
    """Minimal /api/v1 client — same shape as lidarsampling.py's."""

    def __init__(self):
        self.base_url = ""
        self.token    = ""

    def _request(self, method, path, body=None, timeout=5):
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {"Content-Type": "application/json"}
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base_url + path, data=data,
                                     headers=hdrs, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())

    def get(self, path):             return self._request("GET", path)
    def post(self, path, body=None): return self._request("POST", path, body)

    def connect(self, host, port, password):
        self.base_url = f"http://{host}:{port}"
        self.token    = ""
        if password:
            self.token = self.post("/api/v1/auth",
                                   {"password": password}).get("token", "")

    def resolve(self, address):
        """Return the C variable name registered for this IEC address."""
        for name in self.get("/api/v1/variables"):
            info = self.get(f"/api/v1/variables/{name}")
            if (info.get("address") or "").upper() == address.upper():
                return name
        raise KeyError(f"Address not found: {address}")

    def set_interval(self, ms):
        """Push a new stream cadence. Returns the value the server APPLIED
        (it clamps to 5..60000), which is what the sweep must plot."""
        cfg = self.post("/api/v1/runtime/config", {"stream_interval_ms": int(ms)})
        return int(cfg.get("stream_interval_ms", ms))

    def runtime_status(self):
        return self.get("/api/v1/runtime")

    def stream_iter(self):
        hdrs = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        req  = urllib.request.Request(self.base_url + "/api/v1/stream", headers=hdrs)
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
                        if line.startswith("data:"):
                            try:
                                yield json.loads(line[5:].strip())
                            except json.JSONDecodeError:
                                pass


# ── Capture ───────────────────────────────────────────────────────────────────

@dataclass
class Sample:
    t: float          # seconds since capture start
    angle: float      # degrees
    dist: float       # meters
    quality: int      # raw 0..63
    pkt: int          # lidar_pkt_count, -1 when the PLC doesn't expose it
    fresh: bool       # True when this snapshot differs from the previous one


def capture(client, names, seconds, label=""):
    """Drain the SSE stream for `seconds` and return the raw snapshots.

    Every snapshot is kept, including duplicates — the duplicate RATE is
    itself a measurement (it tells you the API is outrunning the PLC), so
    filtering here would destroy the signal we came for.
    """
    a_n = names[ANGLE_ADDR]
    d_n = names[DIST_ADDR]
    q_n = names[QUALITY_ADDR]
    p_n = names.get(PKT_COUNT_ADDR)

    out   = []
    t0    = time.monotonic()
    prev  = None
    for flat in client.stream_iter():
        now = time.monotonic() - t0
        if now > seconds:
            break
        try:
            a = float(flat[a_n])
            d = float(flat[d_n]) * DIST_SCALE_TO_M
            q = int(flat[q_n])
        except (KeyError, TypeError, ValueError):
            continue
        p = -1
        if p_n and p_n in flat:
            try:
                p = int(flat[p_n])
            except (TypeError, ValueError):
                pass

        # "Fresh" = the PLC published a new beam since the last snapshot.
        # Compare on pkt_count when available (authoritative — a genuine
        # repeat beam would otherwise read as stale); fall back to the
        # angle/distance pair.
        key   = p if p >= 0 else (a, d, q)
        fresh = prev is None or key != prev
        prev  = key

        out.append(Sample(now, a, d, q, p, fresh))
        if label and len(out) % 200 == 0:
            print(f"\r    {label}: {len(out):6d} snapshots  "
                  f"({now:4.1f}/{seconds:.0f}s)", end="", flush=True)
    if label:
        print(f"\r    {label}: {len(out):6d} snapshots  "
              f"({seconds:.0f}/{seconds:.0f}s)  done")
    return out


# ── Metrics ───────────────────────────────────────────────────────────────────

def rate_metrics(samples, span_s):
    """Throughput of one capture: snapshot rate, fresh-beam rate, and the
    sensor's true rate + capture ratio when pkt_count is available."""
    n = len(samples)
    if n == 0 or span_s <= 0:
        return dict(snap_hz=0.0, fresh_hz=0.0, yield_pct=0.0,
                    lidar_hz=None, capture_pct=None)

    fresh    = sum(1 for s in samples if s.fresh)
    snap_hz  = n / span_s
    fresh_hz = fresh / span_s

    lidar_hz = capture_pct = None
    pkts = [s.pkt for s in samples if s.pkt >= 0]
    if len(pkts) >= 2:
        # pkt_count is a free-running UDINT counter. Its delta over the
        # capture is exactly how many beams the sensor produced, so the
        # ratio against fresh snapshots is the true capture fraction.
        dp = pkts[-1] - pkts[0]
        if dp < 0:                      # UDINT wrap at 2^32
            dp += 1 << 32
        if dp > 0:
            lidar_hz    = dp / span_s
            capture_pct = 100.0 * fresh / dp

    return dict(snap_hz=snap_hz, fresh_hz=fresh_hz,
                yield_pct=100.0 * fresh / n,
                lidar_hz=lidar_hz, capture_pct=capture_pct)


def angular_gaps(samples):
    """Degrees of rotation between consecutive FRESH beams.

    The median of this is the effective angular resolution — the real
    question a lidar user has ("how big a gap can an object hide in?").
    The mean would be dragged around by wrap-arounds and stalls, so the
    median is the honest summary.
    """
    fresh = [s for s in samples if s.fresh]
    gaps  = []
    for a, b in zip(fresh, fresh[1:]):
        g = (b.angle - a.angle) % 360.0
        # A gap of exactly 0 means the sensor didn't rotate between beams
        # (duplicate angle); >180° is almost certainly a missed wrap rather
        # than a real backwards jump. Both would corrupt the resolution
        # estimate, so they're excluded.
        if 0.0 < g <= 180.0:
            gaps.append(g)
    return np.array(gaps)


def rotation_hz(samples, span_s):
    """Sensor rotation rate, from counting angle wrap-arounds."""
    fresh = [s for s in samples if s.fresh]
    if len(fresh) < 2 or span_s <= 0:
        return None
    wraps = sum(1 for a, b in zip(fresh, fresh[1:]) if b.angle < a.angle - 180.0)
    return wraps / span_s if wraps else None


def coverage_curve(samples, sectors=ANGLE_SECTORS):
    """(elapsed, % of angular sectors seen at least once) — the growth of
    the map. Answers 'how long before I have a full scan?'."""
    seen = np.zeros(sectors, dtype=bool)
    ts, pct = [], []
    for s in samples:
        if not s.fresh or s.dist <= 0:
            continue
        seen[int(s.angle % 360.0 * sectors / 360.0) % sectors] = True
        ts.append(s.t)
        pct.append(100.0 * seen.sum() / sectors)
    return np.array(ts), np.array(pct)


def sensitivity_bins(samples, nbins=20):
    """Per-distance-bin return quality and dropout rate.

    A distance of 0 is the driver's 'no return' marker, so it can't go in
    a distance bin of its own — the dropout rate is instead attributed to
    the ANGULAR SECTOR's median valid distance, i.e. 'at the range where
    this sector's target sits, how often did the beam come back empty?'.
    That is what makes the dropout curve a range-falloff curve rather than
    a count of zeros.
    """
    valid = [s for s in samples if s.fresh and s.dist > 0]
    if not valid:
        return None

    d = np.array([s.dist for s in valid])
    q = np.array([s.quality for s in valid])
    edges   = np.linspace(d.min(), d.max(), nbins + 1)
    centers, q_mean, q_std, counts = [], [], [], []
    for i in range(nbins):
        m = (d >= edges[i]) & (d < edges[i + 1] if i < nbins - 1 else d <= edges[i + 1])
        if m.sum() == 0:
            continue
        centers.append(0.5 * (edges[i] + edges[i + 1]))
        q_mean.append(q[m].mean())
        q_std.append(q[m].std())
        counts.append(int(m.sum()))

    # Dropout per angular sector, placed at that sector's typical range.
    sect_valid, sect_zero = {}, {}
    for s in samples:
        if not s.fresh:
            continue
        k = int(s.angle % 360.0 * ANGLE_SECTORS / 360.0) % ANGLE_SECTORS
        if s.dist > 0:
            sect_valid.setdefault(k, []).append(s.dist)
        else:
            sect_zero[k] = sect_zero.get(k, 0) + 1

    drop_d, drop_pct = [], []
    for k, dists in sect_valid.items():
        z = sect_zero.get(k, 0)
        total = len(dists) + z
        if total >= MIN_SAMPLES_FOR_JITTER:
            drop_d.append(statistics.median(dists))
            drop_pct.append(100.0 * z / total)

    return dict(centers=np.array(centers), q_mean=np.array(q_mean),
                q_std=np.array(q_std), counts=np.array(counts),
                drop_d=np.array(drop_d), drop_pct=np.array(drop_pct))


def jitter_by_sector(samples):
    """Per-sector distance std-dev vs that sector's mean distance.

    Assumes a STATIC scene: with nothing moving, all spread within one
    angular sector is sensor noise, so std-dev IS the repeatability. The
    trend against distance is the noise-vs-range curve.
    """
    sect = {}
    for s in samples:
        if not s.fresh or s.dist <= 0:
            continue
        k = int(s.angle % 360.0 * ANGLE_SECTORS / 360.0) % ANGLE_SECTORS
        sect.setdefault(k, []).append(s.dist)

    means, stds = [], []
    for dists in sect.values():
        if len(dists) >= MIN_SAMPLES_FOR_JITTER:
            means.append(statistics.mean(dists))
            stds.append(statistics.pstdev(dists))
    return np.array(means), np.array(stds)


# ── Plots ─────────────────────────────────────────────────────────────────────

def _note(ax, text):
    ax.text(0.5, 0.5, text, transform=ax.transAxes, ha="center", va="center",
            color=TEXT_MUTE, fontsize=8.5, wrap=True)
    ax.set_xticks([]); ax.set_yticks([])


def plot_throughput(sweep, samples, span_s, path):
    """Figure 1 — what the API can deliver, and what resolution that buys."""
    _style()
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    fig.suptitle("Lidar over KronServer REST — throughput & resolution",
                 fontsize=13, fontweight="bold", color=TEXT)

    # ── Achieved snapshot rate vs configured cadence ──────────────────────
    ax = axes[0][0]
    if sweep:
        iv    = np.array([r["interval"] for r in sweep], dtype=float)
        snap  = np.array([r["snap_hz"]  for r in sweep])
        fresh = np.array([r["fresh_hz"] for r in sweep])
        ideal = 1000.0 / iv

        # The ideal line is a reference, not a series — it rides in the
        # legend rather than as an annotation, because at cadences the
        # server keeps up with it sits exactly under the achieved line and
        # any label pinned to it lands on a marker.
        ax.plot(iv, ideal, "--", color=TEXT_MUTE, lw=1.5, zorder=1,
                label="ideal (1000/interval)")
        ax.plot(iv, snap, "-o", color=S1_BLUE, lw=2, ms=6,
                label="snapshots delivered", zorder=3)
        ax.plot(iv, fresh, "-o", color=S2_GREEN, lw=2, ms=6,
                label="new beams (fresh)", zorder=3)
        ax.set_xscale("log"); ax.set_xticks(iv)
        ax.get_xaxis().set_major_formatter(matplotlib.ticker.ScalarFormatter())
        ax.set_xlabel("configured stream_interval_ms  (log)")
        ax.set_ylabel("rate  (Hz)")
        ax.set_title("Achieved rate vs configured cadence")
        ax.legend(loc="upper right")
        ax.grid(True, axis="y")
        # The gap between the green and blue lines is wasted polling; the gap
        # between blue and the dashed line is the server failing to keep up.
    else:
        _note(ax, "no sweep data\n(--no-sweep or --replay)")

    # ── Yield and capture ratio ───────────────────────────────────────────
    ax = axes[0][1]
    if sweep:
        iv  = np.array([r["interval"] for r in sweep], dtype=float)
        x   = np.arange(len(iv))
        yld = np.array([r["yield_pct"] for r in sweep])
        cap = np.array([r["capture_pct"] if r["capture_pct"] is not None else np.nan
                        for r in sweep])
        w = 0.38
        # 2px surface gap between adjacent bars comes from the width/offset.
        ax.bar(x - w / 2, yld, w, color=S2_GREEN, label="fresh-beam yield",
               edgecolor=PANEL, linewidth=1.5)
        if not np.all(np.isnan(cap)):
            ax.bar(x + w / 2, cap, w, color=S3_MAGENTA,
                   label="captured of sensor output", edgecolor=PANEL, linewidth=1.5)
            for xi, c in zip(x, cap):
                if not np.isnan(c):
                    ax.text(xi + w / 2, c, f"{c:.1f}%", ha="center", va="bottom",
                            color=TEXT_DIM, fontsize=7)
        else:
            ax.text(0.5, 0.9, "capture ratio needs lidar_pkt_count (%MD22)",
                    transform=ax.transAxes, ha="center", color=TEXT_MUTE, fontsize=7.5)
        ax.set_xticks(x); ax.set_xticklabels([f"{int(v)}" for v in iv])
        ax.set_xlabel("stream_interval_ms")
        ax.set_ylabel("percent")
        ax.set_title("Yield (is polling helping?) vs capture ratio")
        # Yield saturates at 100%, so reserve a clear band above it for the
        # legend instead of letting it land on the bars.
        ax.set_ylim(0, 132)
        ax.legend(loc="upper center", ncol=2)
        ax.grid(True, axis="y")
    else:
        _note(ax, "no sweep data\n(--no-sweep or --replay)")

    # ── Angular gap distribution → effective resolution ───────────────────
    ax = axes[1][0]
    gaps = angular_gaps(samples)
    if gaps.size:
        med = float(np.median(gaps))
        p95 = float(np.percentile(gaps, 95))
        # A perfectly steady sensor + steady poll makes every gap identical,
        # which gives numpy a zero-width range and no valid bin edges. Pad
        # the range so the degenerate case renders as one spike.
        lo, hi = float(gaps.min()), float(gaps.max())
        rng = (lo - 0.5, hi + 0.5) if hi - lo < 1e-6 else (lo, hi)
        ax.hist(gaps, bins=60, range=rng, color=S1_BLUE,
                edgecolor=PANEL, linewidth=0.5)
        ax.axvline(med, color=S4_YELLOW, lw=2)
        ax.axvline(p95, color=S3_MAGENTA, lw=2, ls="--")
        ax.annotate(f"median {med:.2f}°\n= effective resolution",
                    xy=(med, ax.get_ylim()[1] * 0.92), xytext=(8, 0),
                    textcoords="offset points", color=S4_YELLOW, fontsize=8,
                    fontweight="bold", va="top")
        ax.annotate(f"p95 {p95:.2f}°\nworst-case blind arc",
                    xy=(p95, ax.get_ylim()[1] * 0.55), xytext=(8, 0),
                    textcoords="offset points", color=S3_MAGENTA, fontsize=8, va="top")
        ax.set_xlabel("rotation between consecutive captured beams  (°)")
        ax.set_ylabel("count")
        ax.set_title("Effective angular resolution")
        ax.grid(True, axis="y")
    else:
        _note(ax, "no fresh beams captured")

    # ── Coverage growth ───────────────────────────────────────────────────
    ax = axes[1][1]
    ts, pct = coverage_curve(samples)
    if ts.size:
        ax.plot(ts, pct, color=S5_VIOLET, lw=2)
        ax.fill_between(ts, 0, pct, color=S5_VIOLET, alpha=0.15)
        for target in (50.0, 90.0):
            hit = np.argmax(pct >= target) if (pct >= target).any() else None
            if hit is not None and pct[hit] >= target:
                ax.axhline(target, color=GRID, lw=0.8, ls=":")
                ax.annotate(f"{target:.0f}% @ {ts[hit]:.1f}s",
                            xy=(ts[hit], target), xytext=(4, 4),
                            textcoords="offset points", color=TEXT_DIM, fontsize=7.5)
        ax.set_xlabel("elapsed  (s)")
        ax.set_ylabel(f"sectors visited  (% of {ANGLE_SECTORS})")
        ax.set_ylim(0, 105)
        ax.set_title("Map build-up — time to a usable scan")
        ax.grid(True, axis="y")
    else:
        _note(ax, "no valid returns captured")

    fig.savefig(path, dpi=130)
    plt.close(fig)
    return path


def plot_sensor(samples, path):
    """Figure 2 — the sensor itself: sensitivity, dropout, precision, map."""
    _style()
    fig = plt.figure(figsize=(12, 8))
    fig.suptitle("Lidar sensor characterisation — sensitivity & precision",
                 fontsize=13, fontweight="bold", color=TEXT)
    gs  = fig.add_gridspec(2, 2)
    ax1 = fig.add_subplot(gs[0, 0])
    ax2 = fig.add_subplot(gs[0, 1])
    ax3 = fig.add_subplot(gs[1, 0])
    ax4 = fig.add_subplot(gs[1, 1], projection="polar")

    sens = sensitivity_bins(samples)

    # ── Return quality vs distance (the sensitivity curve) ────────────────
    if sens is not None and sens["centers"].size:
        c, m, sd = sens["centers"], sens["q_mean"], sens["q_std"]
        ax1.fill_between(c, m - sd, m + sd, color=S1_BLUE, alpha=0.2)
        ax1.plot(c, m, "-o", color=S1_BLUE, lw=2, ms=5)
        ax1.set_xlabel("distance  (m)")
        ax1.set_ylabel(f"return quality  (0..{QUALITY_MAX})")
        ax1.set_title("Sensitivity — signal strength vs range")
        ax1.grid(True, axis="y")
        ax1.annotate("band = ±1σ", xy=(0.97, 0.94), xycoords="axes fraction",
                     ha="right", color=TEXT_MUTE, fontsize=7.5)
    else:
        _note(ax1, "no valid returns captured")

    # ── Dropout vs range ─────────────────────────────────────────────────
    if sens is not None and sens["drop_d"].size:
        order = np.argsort(sens["drop_d"])
        d, p  = sens["drop_d"][order], sens["drop_pct"][order]
        ax2.scatter(d, p, s=26, color=S3_MAGENTA, edgecolor=PANEL, linewidth=0.5)
        if d.size >= 3:
            # Linear trend only — a higher-order fit on noisy sector stats
            # would invent structure that isn't in the data.
            k, b = np.polyfit(d, p, 1)
            xs = np.linspace(d.min(), d.max(), 50)
            ax2.plot(xs, k * xs + b, color=S4_YELLOW, lw=2, ls="--")
            ax2.annotate(f"trend {k:+.1f} %/m", xy=(0.97, 0.94),
                         xycoords="axes fraction", ha="right",
                         color=S4_YELLOW, fontsize=8, fontweight="bold")
        ax2.set_xlabel("sector median distance  (m)")
        ax2.set_ylabel("no-return rate  (%)")
        ax2.set_title("Dropout — where the beam stops coming back")
        ax2.grid(True, axis="y")
        # Headroom so the trend annotation never lands on a data point.
        ax2.set_ylim(bottom=min(0.0, p.min()), top=max(p.max() * 1.35, 1.0))
    else:
        _note(ax2, "not enough per-sector samples\nfor dropout statistics")

    # ── Precision / jitter vs distance ───────────────────────────────────
    means, stds = jitter_by_sector(samples)
    if means.size:
        mm = stds * 1000.0
        ax3.scatter(means, mm, s=26, color=S2_GREEN, edgecolor=PANEL, linewidth=0.5)
        if means.size >= 3:
            k, b = np.polyfit(means, mm, 1)
            xs = np.linspace(means.min(), means.max(), 50)
            ax3.plot(xs, k * xs + b, color=S4_YELLOW, lw=2, ls="--")
            ax3.annotate(f"noise growth {k:+.1f} mm/m\nmedian σ {np.median(mm):.0f} mm",
                         xy=(0.97, 0.94), xycoords="axes fraction", ha="right",
                         va="top", color=S4_YELLOW, fontsize=8, fontweight="bold")
        ax3.set_xlabel("sector mean distance  (m)")
        ax3.set_ylabel("distance σ  (mm)")
        ax3.set_title("Precision — repeatability vs range  (static scene only)")
        ax3.grid(True, axis="y")
        ax3.set_ylim(bottom=0.0, top=max(mm.max() * 1.35, 1.0))
    else:
        _note(ax3, f"need ≥{MIN_SAMPLES_FOR_JITTER} samples in a sector\n"
                   "— capture longer")

    # ── The captured map, quality-shaded ─────────────────────────────────
    valid = [s for s in samples if s.fresh and s.dist > 0]
    if valid:
        # Lidar convention: 0° = forward/up, clockwise. Matplotlib's polar is
        # counter-clockwise from east, so set the origin north and the
        # direction to -1 rather than pre-rotating the data.
        th = np.array([math.radians(s.angle) for s in valid])
        r  = np.array([s.dist for s in valid])
        q  = np.array([s.quality for s in valid], dtype=float)
        ax4.set_theta_zero_location("N")
        ax4.set_theta_direction(-1)
        sc = ax4.scatter(th, r, c=q, cmap=SEQ_BLUE, s=7,
                         vmin=0, vmax=QUALITY_MAX, alpha=0.9)
        cb = fig.colorbar(sc, ax=ax4, pad=0.1, shrink=0.75)
        cb.set_label("return quality", color=TEXT_DIM, fontsize=8)
        cb.ax.tick_params(colors=TEXT_MUTE, labelsize=7)
        cb.outline.set_edgecolor(GRID)
        ax4.set_facecolor(PANEL)
        ax4.tick_params(colors=TEXT_MUTE, labelsize=7)
        ax4.grid(color=GRID, alpha=0.4)
        ax4.set_title(f"Captured scan  ({len(valid)} beams)", pad=14)
    else:
        _note(ax4, "no valid returns")

    fig.savefig(path, dpi=130)
    plt.close(fig)
    return path


# ── CSV ───────────────────────────────────────────────────────────────────────

def write_csv(samples, path):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t_s", "angle_deg", "dist_m", "quality", "pkt_count", "fresh"])
        for s in samples:
            w.writerow([f"{s.t:.6f}", f"{s.angle:.4f}", f"{s.dist:.6f}",
                        s.quality, s.pkt, int(s.fresh)])
    return path


def read_csv(path):
    out = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            out.append(Sample(float(row["t_s"]), float(row["angle_deg"]),
                              float(row["dist_m"]), int(row["quality"]),
                              int(row["pkt_count"]), row["fresh"] == "1"))
    return out


# ── Report ────────────────────────────────────────────────────────────────────

def report(sweep, samples, span_s):
    print("\n" + "═" * 68)
    print("  THROUGHPUT — what the REST API actually delivers")
    print("═" * 68)
    if sweep:
        print(f"  {'interval':>9} {'snapshots':>11} {'fresh':>9} {'yield':>8} "
              f"{'sensor':>10} {'captured':>9}")
        print(f"  {'(ms)':>9} {'(Hz)':>11} {'(Hz)':>9} {'(%)':>8} "
              f"{'(Hz)':>10} {'(%)':>9}")
        print("  " + "─" * 64)
        for r in sweep:
            lh = f"{r['lidar_hz']:.0f}"     if r["lidar_hz"]    is not None else "—"
            cp = f"{r['capture_pct']:.2f}"  if r["capture_pct"] is not None else "—"
            print(f"  {r['interval']:>9} {r['snap_hz']:>11.1f} {r['fresh_hz']:>9.1f} "
                  f"{r['yield_pct']:>8.1f} {lh:>10} {cp:>9}")
        best = max(sweep, key=lambda r: r["fresh_hz"])
        print(f"\n  → Peak new-beam rate: {best['fresh_hz']:.1f} Hz "
              f"at {best['interval']} ms.")
        print(f"    Server clamp is {MIN_INTERVAL_MS} ms, so {1000/MIN_INTERVAL_MS:.0f} Hz "
              f"is the absolute API ceiling —")
        print(f"    one beam per snapshot, no batching.")
        if best["capture_pct"] is not None:
            print(f"    You are capturing {best['capture_pct']:.2f}% of the beams the "
                  f"sensor emits.")
            print(f"    The other {100-best['capture_pct']:.2f}% are overwritten in "
                  f"shared memory between polls.")

    m = rate_metrics(samples, span_s)
    print("\n" + "═" * 68)
    print(f"  CHARACTERISATION CAPTURE — {len(samples)} snapshots over {span_s:.1f}s")
    print("═" * 68)
    print(f"  snapshot rate      {m['snap_hz']:.1f} Hz")
    print(f"  fresh-beam rate    {m['fresh_hz']:.1f} Hz   (yield {m['yield_pct']:.1f}%)")
    if m["lidar_hz"] is not None:
        print(f"  sensor output      {m['lidar_hz']:.0f} Hz")
        print(f"  capture ratio      {m['capture_pct']:.2f}%")

    rot = rotation_hz(samples, span_s)
    if rot:
        print(f"  rotation rate      {rot:.2f} Hz  ({rot*60:.0f} RPM)")
        if m["lidar_hz"]:
            native = 360.0 / (m["lidar_hz"] / rot)
            print(f"  native resolution  {native:.3f}°/beam  "
                  f"({m['lidar_hz']/rot:.0f} beams/rev at the sensor)")

    gaps = angular_gaps(samples)
    if gaps.size:
        print(f"  effective res.     {np.median(gaps):.2f}°/beam  (median gap)")
        print(f"  worst blind arc    {np.percentile(gaps, 95):.2f}°  (p95 gap)")

    valid   = [s for s in samples if s.fresh and s.dist > 0]
    zeros   = sum(1 for s in samples if s.fresh and s.dist <= 0)
    total_f = len(valid) + zeros
    if total_f:
        print(f"  dropout rate       {100.0*zeros/total_f:.1f}%  "
              f"(no return on {zeros}/{total_f} beams)")
    if valid:
        d = [s.dist for s in valid]
        q = [s.quality for s in valid]
        print(f"  range seen         {min(d):.2f} .. {max(d):.2f} m")
        print(f"  mean quality       {statistics.mean(q):.1f} / {QUALITY_MAX}")

    means, stds = jitter_by_sector(samples)
    if stds.size:
        print(f"  median jitter      {np.median(stds)*1000:.0f} mm σ  "
              f"(over {stds.size} sectors, static scene assumed)")
    print("═" * 68 + "\n")


# ── Main ──────────────────────────────────────────────────────────────────────

def check_interval(ms):
    """Reject a cadence the server would clamp, rather than letting it lie."""
    if ms < MIN_INTERVAL_MS or ms > MAX_INTERVAL_MS:
        raise ValueError(
            f"interval {ms} ms is outside the server clamp "
            f"({MIN_INTERVAL_MS}..{MAX_INTERVAL_MS} ms). "
            f"{MIN_INTERVAL_MS} ms = {1000//MIN_INTERVAL_MS} Hz is the API ceiling.")
    return ms


def parse_sweep(spec):
    """'5,10,50' → [5, 10, 50], every entry validated against the clamp."""
    out = []
    for tok in spec.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            v = int(tok)
        except ValueError:
            raise ValueError(f"--sweep: '{tok}' is not an integer (ms)")
        out.append(check_interval(v))
    if not out:
        raise ValueError("--sweep: no intervals given")
    return sorted(set(out))


def run_sweep(client, names, intervals, seconds):
    results = []
    print("\n[*] Throughput sweep — probing the API ceiling")
    for ms in intervals:
        applied = client.set_interval(ms)
        if applied != ms:
            print(f"    server clamped {ms} → {applied} ms")
        # Let the in-flight snapshot drain so the first sample of the new
        # capture isn't still on the old cadence.
        time.sleep(0.3)
        t0 = time.monotonic()
        s  = capture(client, names, seconds, label=f"{applied:>3} ms")
        span = time.monotonic() - t0
        r = rate_metrics(s, span)
        r["interval"] = applied
        results.append(r)
    return results


def main():
    ap = argparse.ArgumentParser(
        description="Lidar sampling & sensor characterisation over the "
                    "KronServer REST API.")
    ap.add_argument("--host", default="192.168.1.129")
    ap.add_argument("--port", default="7070")
    ap.add_argument("--password", default="krontek")
    ap.add_argument("--capture", type=float, default=CAPTURE_SECONDS,
                    help="characterisation capture length in seconds "
                         f"(default {CAPTURE_SECONDS:.0f})")
    ap.add_argument("--no-sweep", action="store_true",
                    help="skip the throughput sweep, capture only")
    ap.add_argument("--interval", type=int, default=ANALYSIS_INTERVAL_MS,
                    metavar="MS",
                    help="stream_interval_ms for the characterisation capture — "
                         f"the poll cadence (default {ANALYSIS_INTERVAL_MS}, "
                         f"server clamp {MIN_INTERVAL_MS}..{MAX_INTERVAL_MS})")
    ap.add_argument("--sweep", metavar="MS,MS,…",
                    help="comma-separated cadences for the throughput sweep "
                         f"(default {','.join(str(v) for v in SWEEP_INTERVALS_MS)})")
    ap.add_argument("--sweep-seconds", type=float, default=SWEEP_SECONDS,
                    metavar="S",
                    help=f"seconds to capture per sweep step "
                         f"(default {SWEEP_SECONDS:.0f})")
    ap.add_argument("--replay", metavar="CSV",
                    help="analyse a previously saved capture, no PLC needed")
    ap.add_argument("--out-dir", default=".", help="where to write CSV + PNGs")
    args = ap.parse_args()

    out = args.out_dir.rstrip("/")

    # Validate cadences up front — reaching the PLC and running a whole sweep
    # only to have the server silently clamp every request would produce plots
    # whose "configured" axis is a lie.
    try:
        capture_ms = check_interval(args.interval)
        sweep_ms   = (parse_sweep(args.sweep) if args.sweep
                      else list(SWEEP_INTERVALS_MS))
    except ValueError as e:
        print(f"[X] {e}"); sys.exit(1)

    if args.replay:
        print(f"[*] Replaying {args.replay}")
        samples = read_csv(args.replay)
        if not samples:
            print("[X] No samples in file"); sys.exit(2)
        span = samples[-1].t
        sweep = []
    else:
        client = KronClient()
        print(f"[*] Connecting to http://{args.host}:{args.port}")
        try:
            client.connect(args.host, args.port, args.password)
        except Exception as e:
            print(f"[X] Connect/auth failed: {e}"); sys.exit(1)

        names, missing = {}, []
        for addr in REQ_ADDRESSES:
            try:
                names[addr] = client.resolve(addr)
                print(f"    [✓] {addr:<7} → {names[addr]}")
            except Exception:
                missing.append(addr)
        if missing:
            print(f"\n[X] Required address(es) not found: {', '.join(missing)}")
            print("    Declare them on GLOBAL variables in KronEditor, then "
                  "Build & Send.")
            sys.exit(2)
        for addr in OPT_ADDRESSES:
            try:
                names[addr] = client.resolve(addr)
                print(f"    [✓] {addr:<7} → {names[addr]}  (enables capture ratio)")
            except Exception:
                print(f"    [ ] {addr:<7} → absent — sensor-rate and capture-ratio "
                      f"analysis disabled")

        try:
            st = client.runtime_status()
            if not st.get("running"):
                print("\n[!] Runtime is NOT running — the lidar driver isn't "
                      "publishing.\n    Start it and re-run.")
                sys.exit(3)
        except Exception as e:
            print(f"[!] Could not read runtime status: {e}")

        original_ms = None
        try:
            original_ms = int(client.runtime_status().get("stream_interval_ms", 50))
        except Exception:
            pass

        try:
            sweep = ([] if args.no_sweep
                     else run_sweep(client, names, sweep_ms, args.sweep_seconds))

            print(f"\n[*] Characterisation capture — {args.capture:.0f}s at "
                  f"{capture_ms} ms ({1000.0/capture_ms:.0f} Hz)")
            print("    Keep the scene STATIC (nothing moving) — precision and")
            print("    dropout-vs-range are only valid against a fixed scene.")
            applied = client.set_interval(capture_ms)
            if applied != capture_ms:
                print(f"    [!] server applied {applied} ms, not {capture_ms}")
            time.sleep(0.3)
            t0      = time.monotonic()
            samples = capture(client, names, args.capture, label="capture")
            span    = time.monotonic() - t0
        finally:
            # Always hand the server back the cadence we found it on — this
            # setting is global and persists, so leaving it at 5 ms would
            # silently tax every other client (and the editor's own poll).
            if original_ms is not None:
                try:
                    client.set_interval(original_ms)
                    print(f"[*] Restored stream_interval_ms = {original_ms}")
                except Exception as e:
                    print(f"[!] Could not restore stream_interval_ms: {e}")

        if not samples:
            print("[X] No samples captured"); sys.exit(4)
        csv_path = write_csv(samples, f"{out}/lidar_capture.csv")
        print(f"[*] Raw capture → {csv_path}")

    report(sweep, samples, span)

    p1 = plot_throughput(sweep, samples, span, f"{out}/lidar_throughput.png")
    p2 = plot_sensor(samples, f"{out}/lidar_sensor.png")
    print(f"[*] Plots → {p1}\n           {p2}")


if __name__ == "__main__":
    main()
