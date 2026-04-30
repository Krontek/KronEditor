"""
lidarsampling.py — KronServer Lidar Sampling Viewer (API sample)
================================================================
Streams a single-beam lidar reading from the PLC and plots the most
recent samples in polar coordinates. The "Frequency" entry pushes a
new cadence to /api/v1/runtime/config so you can watch the visible
sample rate change live without reconnecting the SSE stream.

This script is intentionally a complement to Onemotorcontrol.py:
  - Onemotorcontrol.py demonstrates writes (force-write, runtime
    start/stop, AutoRun toggle).
  - lidarsampling.py demonstrates reads, the live SSE stream, and
    server-side cadence control.

Project requirements (PLC variables marked addressed in KronEditor):
  %MD20  REAL   — beam angle in degrees (0° = forward, clockwise)
  %MD21  REAL   — beam distance in meters
  %MB5   USINT  — quality / signal strength (0..255)

Usage:  python3 lidarsampling.py
"""

import collections
import json
import math
import threading
import time
import tkinter as tk
from tkinter import messagebox
import urllib.request


# ── Theme ─────────────────────────────────────────────────────────────────────
BG       = "#1e1e1e"
BG2      = "#252526"
BG3      = "#2d2d2d"
BORDER   = "#3a3a3a"
ACCENT   = "#007acc"
GREEN    = "#00e676"
RED      = "#ef5350"
YELLOW   = "#ffb300"
TEXT     = "#cccccc"
TEXT_DIM = "#666666"
TEXT_H   = "#9cdcfe"

# ── Addresses ─────────────────────────────────────────────────────────────────
ANGLE_ADDR    = "%MD20"
DIST_ADDR     = "%MD21"
QUALITY_ADDR  = "%MB5"
ALL_ADDRESSES = (ANGLE_ADDR, DIST_ADDR, QUALITY_ADDR)

# ── Display ───────────────────────────────────────────────────────────────────
CANVAS_SIZE        = 540
CANVAS_MARGIN      = 36
MAX_BUFFER         = 720          # ~one full revolution at 0.5° resolution
DEFAULT_RANGE_M    = 5.0
REDRAW_INTERVAL_MS = 50           # canvas refresh — independent of stream rate
RATE_WINDOW_S      = 1.0          # live Hz readout averaged over this window


# ── API client ────────────────────────────────────────────────────────────────

class KronClient:
    """Minimal /api/v1 client. Same shape as Onemotorcontrol.py's client."""

    def __init__(self):
        self.base_url  = ""
        self.token     = ""
        self.connected = False

    def _request(self, method, path, body=None, timeout=5):
        url  = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {"Content-Type": "application/json"}
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())

    def get(self, path):              return self._request("GET",  path)
    def post(self, path, body=None):  return self._request("POST", path, body)

    def connect(self, host, port, password):
        self.base_url = f"http://{host}:{port}"
        self.token    = ""
        if password:
            resp = self.post("/api/v1/auth", {"password": password})
            self.token = resp.get("token", "")
        self.connected = True

    def resolve(self, address):
        """Return the C variable name registered for this IEC address."""
        all_vals = self.get("/api/v1/variables")
        for name in all_vals:
            d = self.get(f"/api/v1/variables/{name}")
            if (d.get("address") or "").upper() == address.upper():
                return name
        raise KeyError(f"Address not found: {address}")

    def runtime_status(self):
        return self.get("/api/v1/runtime")

    def runtime_config(self, stream_interval_ms=None, auto_run=None):
        body = {}
        if stream_interval_ms is not None:
            body["stream_interval_ms"] = int(stream_interval_ms)
        if auto_run is not None:
            body["auto_run"] = bool(auto_run)
        return self.post("/api/v1/runtime/config", body)

    def stream_iter(self):
        url  = self.base_url + "/api/v1/stream"
        hdrs = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        req  = urllib.request.Request(url, headers=hdrs)
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


# ── App ───────────────────────────────────────────────────────────────────────

class LidarApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Lidar Sampling — KronServer")
        self.configure(bg=BG)
        self.resizable(False, False)

        self.client     = KronClient()
        self._names     = {}     # address → varname
        self._streaming = False

        # All sample state is guarded by a single lock — the SSE worker
        # thread mutates these while the Tk main thread reads them in
        # _redraw_canvas / _update_readout.
        self._lock          = threading.Lock()
        self._samples       = collections.deque(maxlen=MAX_BUFFER)
        self._last_angle    = 0.0
        self._last_dist     = 0.0
        self._last_quality  = 0
        self._sample_times  = collections.deque()
        self._sample_count  = 0

        self._range_m         = DEFAULT_RANGE_M
        self._redraw_after_id = None

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._schedule_redraw()

    # ── UI construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        self._build_connection_bar()
        self._build_control_bar()
        self._build_canvas()
        self._build_footer()

    def _build_connection_bar(self):
        conn = tk.Frame(self, bg=BG2, padx=10, pady=8)
        conn.pack(fill=tk.X)

        def lbl(t):
            return tk.Label(conn, text=t, bg=BG2, fg=TEXT,
                            font=("Consolas", 10))

        def ent(w, show=None):
            kw = {"show": show} if show else {}
            return tk.Entry(conn, width=w, bg=BG3, fg=TEXT,
                            insertbackground=TEXT, relief=tk.FLAT,
                            font=("Consolas", 10), highlightthickness=1,
                            highlightbackground=BORDER, **kw)

        lbl("Host:").pack(side=tk.LEFT)
        self.ent_host = ent(15); self.ent_host.insert(0, "192.168.1.121")
        self.ent_host.pack(side=tk.LEFT, padx=(3, 10))

        lbl("Port:").pack(side=tk.LEFT)
        self.ent_port = ent(6); self.ent_port.insert(0, "7070")
        self.ent_port.pack(side=tk.LEFT, padx=(3, 10))

        lbl("Password:").pack(side=tk.LEFT)
        self.ent_pass = ent(12, show="*"); self.ent_pass.insert(0, "krontek")
        self.ent_pass.pack(side=tk.LEFT, padx=(3, 10))
        self.ent_pass.bind("<Return>", lambda _: self._on_connect())

        self.btn_conn = tk.Button(conn, text="Connect", bg=ACCENT, fg="#fff",
                                  relief=tk.FLAT, font=("Consolas", 10, "bold"),
                                  padx=12, pady=2, cursor="hand2",
                                  command=self._on_connect)
        self.btn_conn.pack(side=tk.LEFT, padx=(0, 12))

        self.lbl_conn = tk.Label(conn, text="● Disconnected", bg=BG2, fg=RED,
                                 font=("Consolas", 10, "bold"))
        self.lbl_conn.pack(side=tk.LEFT)

    def _build_control_bar(self):
        bar = tk.Frame(self, bg=BG3, padx=10, pady=8)
        bar.pack(fill=tk.X)

        # Frequency control — pushes /api/v1/runtime/config on Apply.
        # Server clamps to 5..60000 ms; the response carries the actual
        # value applied, which we mirror back into the entry.
        tk.Label(bar, text="Frequency:", bg=BG3, fg=TEXT,
                 font=("Consolas", 10, "bold")).pack(side=tk.LEFT)
        self.ent_freq = tk.Entry(bar, width=6, bg=BG2, fg=TEXT,
                                 insertbackground=TEXT, relief=tk.FLAT,
                                 font=("Consolas", 10), highlightthickness=1,
                                 highlightbackground=BORDER, justify=tk.RIGHT,
                                 state=tk.DISABLED)
        self.ent_freq.pack(side=tk.LEFT, padx=(4, 2))
        tk.Label(bar, text="ms", bg=BG3, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.LEFT)
        self.btn_apply = tk.Button(bar, text="Apply", bg=ACCENT, fg="#fff",
                                   relief=tk.FLAT, font=("Consolas", 9, "bold"),
                                   padx=8, pady=2, cursor="hand2",
                                   state=tk.DISABLED, command=self._apply_freq)
        self.btn_apply.pack(side=tk.LEFT, padx=(6, 4))
        self.ent_freq.bind("<Return>", lambda _: self._apply_freq())

        self.lbl_server = tk.Label(bar, text="server: —", bg=BG3, fg=TEXT_DIM,
                                   font=("Consolas", 9))
        self.lbl_server.pack(side=tk.LEFT, padx=(8, 18))

        # Plot range — local, does not talk to the server.
        tk.Label(bar, text="Range:", bg=BG3, fg=TEXT,
                 font=("Consolas", 10)).pack(side=tk.LEFT)
        self.ent_range = tk.Entry(bar, width=5, bg=BG2, fg=TEXT,
                                  insertbackground=TEXT, relief=tk.FLAT,
                                  font=("Consolas", 10), highlightthickness=1,
                                  highlightbackground=BORDER, justify=tk.RIGHT)
        self.ent_range.insert(0, f"{DEFAULT_RANGE_M:g}")
        self.ent_range.pack(side=tk.LEFT, padx=(4, 2))
        tk.Label(bar, text="m", bg=BG3, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.LEFT)
        self.btn_range = tk.Button(bar, text="Set", bg=BG2, fg=TEXT,
                                   relief=tk.FLAT, font=("Consolas", 9),
                                   padx=8, pady=2, cursor="hand2",
                                   command=self._apply_range)
        self.btn_range.pack(side=tk.LEFT, padx=(6, 14))
        self.ent_range.bind("<Return>", lambda _: self._apply_range())

        self.btn_clear = tk.Button(bar, text="Clear", bg="#3a1212", fg=TEXT,
                                   relief=tk.FLAT, font=("Consolas", 9),
                                   padx=8, pady=2, cursor="hand2",
                                   command=self._clear_buffer)
        self.btn_clear.pack(side=tk.LEFT)

    def _build_canvas(self):
        wrap = tk.Frame(self, bg=BG, padx=10, pady=8)
        wrap.pack(pady=(10, 6))
        self.canvas = tk.Canvas(wrap, width=CANVAS_SIZE, height=CANVAS_SIZE,
                                bg="#0a0f0a", highlightthickness=1,
                                highlightbackground=BORDER)
        self.canvas.pack()

    def _build_footer(self):
        ft = tk.Frame(self, bg=BG, padx=10, pady=4)
        ft.pack(fill=tk.X, pady=(2, 10))
        self.lbl_readout = tk.Label(ft, text="", bg=BG, fg=TEXT_H,
                                    font=("Consolas", 11))
        self.lbl_readout.pack(side=tk.LEFT)
        self.lbl_err = tk.Label(ft, text="", bg=BG, fg=TEXT_DIM,
                                font=("Consolas", 9))
        self.lbl_err.pack(side=tk.RIGHT)

    # ── Connection ────────────────────────────────────────────────────────────

    def _on_connect(self):
        self.btn_conn.config(state=tk.DISABLED, text="Connecting…")
        self._log("")
        threading.Thread(target=self._do_connect, daemon=True).start()

    def _do_connect(self):
        host = self.ent_host.get().strip()
        port = self.ent_port.get().strip()
        pw   = self.ent_pass.get().strip()
        try:
            self.client.connect(host, port, pw)
            for addr in ALL_ADDRESSES:
                self._names[addr.upper()] = self.client.resolve(addr)
            try:
                st = self.client.runtime_status()
                ms = int(st.get("stream_interval_ms", 50))
            except Exception:
                ms = 50
            self.after(0, self._on_connected, ms)
        except Exception as e:
            self.after(0, self._on_connect_fail, str(e))

    def _on_connected(self, server_ms):
        self.btn_conn.config(state=tk.NORMAL, text="Reconnect")
        self.lbl_conn.config(text="● Connected", fg=GREEN)
        self.ent_freq.config(state=tk.NORMAL)
        self.ent_freq.delete(0, tk.END)
        self.ent_freq.insert(0, str(server_ms))
        self.lbl_server.config(text=f"server: {server_ms} ms", fg=TEXT)
        self.btn_apply.config(state=tk.NORMAL)
        self._start_stream()
        self._log("Streaming…")

    def _on_connect_fail(self, err):
        self.btn_conn.config(state=tk.NORMAL, text="Connect")
        self.lbl_conn.config(text="● Error", fg=YELLOW)
        messagebox.showerror("Connection Failed", err)

    # ── Frequency / range / clear ─────────────────────────────────────────────

    def _apply_freq(self):
        try:
            ms = int(self.ent_freq.get().strip())
        except ValueError:
            self._log("Frequency must be an integer (ms)")
            return
        self.btn_apply.config(state=tk.DISABLED)
        threading.Thread(target=self._do_apply_freq,
                         args=(ms,), daemon=True).start()

    def _do_apply_freq(self, ms):
        try:
            cfg = self.client.runtime_config(stream_interval_ms=ms)
            applied = int(cfg.get("stream_interval_ms", ms))
            self.after(0, self._set_freq_ui, applied, applied != ms)
        except Exception as e:
            self.after(0, self._log, f"Frequency error: {e}")
        finally:
            self.after(0, lambda: self.btn_apply.config(state=tk.NORMAL))

    def _set_freq_ui(self, ms, was_clamped):
        self.lbl_server.config(text=f"server: {ms} ms")
        if was_clamped:
            self.ent_freq.delete(0, tk.END)
            self.ent_freq.insert(0, str(ms))
            self._log(f"Frequency clamped to {ms} ms by server (range 5..60000)")

    def _apply_range(self):
        try:
            r = float(self.ent_range.get().strip())
        except ValueError:
            self._log("Range must be a number (m)")
            return
        if r <= 0:
            self._log("Range must be positive")
            return
        self._range_m = r

    def _clear_buffer(self):
        with self._lock:
            self._samples.clear()
            self._sample_times.clear()
            self._sample_count = 0

    # ── SSE stream ────────────────────────────────────────────────────────────

    def _start_stream(self):
        self._streaming = True
        threading.Thread(target=self._stream_worker, daemon=True).start()

    def _stream_worker(self):
        try:
            for flat in self.client.stream_iter():
                if not self._streaming:
                    break
                self._handle_sample(flat)
        except Exception:
            if self._streaming:
                self.after(0, self.lbl_conn.config,
                           {"text": "● Stream lost", "fg": YELLOW})

    def _handle_sample(self, flat: dict):
        a_n = self._names.get(ANGLE_ADDR.upper())
        d_n = self._names.get(DIST_ADDR.upper())
        q_n = self._names.get(QUALITY_ADDR.upper())
        now = time.monotonic()
        with self._lock:
            if a_n in flat:
                try: self._last_angle = float(flat[a_n])
                except (TypeError, ValueError): pass
            if d_n in flat:
                try: self._last_dist = float(flat[d_n])
                except (TypeError, ValueError): pass
            if q_n in flat:
                try: self._last_quality = int(flat[q_n])
                except (TypeError, ValueError): pass
            self._samples.append(
                (self._last_angle, self._last_dist, self._last_quality)
            )
            self._sample_times.append(now)
            cutoff = now - RATE_WINDOW_S
            while self._sample_times and self._sample_times[0] < cutoff:
                self._sample_times.popleft()
            self._sample_count += 1

    # ── Drawing ───────────────────────────────────────────────────────────────

    def _schedule_redraw(self):
        try:
            self._redraw_canvas()
            self._update_readout()
        finally:
            self._redraw_after_id = self.after(REDRAW_INTERVAL_MS,
                                               self._schedule_redraw)

    def _redraw_canvas(self):
        c = self.canvas
        c.delete("all")
        cx = cy = CANVAS_SIZE // 2
        max_radius = cx - CANVAS_MARGIN
        rng   = self._range_m if self._range_m > 0 else 1.0
        scale = max_radius / rng

        # Range rings + labels (lidar convention: 0° = up, clockwise).
        step = self._ring_step(rng)
        r = step
        while r <= rng + 1e-6:
            rr = r * scale
            c.create_oval(cx - rr, cy - rr, cx + rr, cy + rr,
                          outline="#1d2a1d", width=1)
            c.create_text(cx + rr - 3, cy - 3, text=f"{r:g} m",
                          fill=TEXT_DIM, font=("Consolas", 7), anchor="se")
            r += step

        # Cardinal cross + labels
        c.create_line(cx, CANVAS_MARGIN, cx, CANVAS_SIZE - CANVAS_MARGIN,
                      fill="#15201a")
        c.create_line(CANVAS_MARGIN, cy, CANVAS_SIZE - CANVAS_MARGIN, cy,
                      fill="#15201a")
        for label, ang in (("0°", 0), ("90°", 90), ("180°", 180), ("270°", 270)):
            ar = math.radians(ang)
            lx = cx + math.sin(ar) * (max_radius + 14)
            ly = cy - math.cos(ar) * (max_radius + 14)
            c.create_text(lx, ly, text=label, fill=TEXT_DIM,
                          font=("Consolas", 8))

        # Snapshot under the lock to avoid drawing a torn buffer.
        with self._lock:
            samples = list(self._samples)

        n = len(samples)
        for i, (a, d, q) in enumerate(samples):
            if d <= 0 or d > rng:
                continue
            ar = math.radians(a)
            rr = d * scale
            x  = cx + math.sin(ar) * rr
            y  = cy - math.cos(ar) * rr

            # Brightness fades from age (newest = bright); quality
            # contributes the remaining 65 % of the luminance budget.
            age_frac = (n - 1 - i) / max(1, n - 1)   # 0 newest, 1 oldest
            life     = 1.0 - age_frac
            qf       = max(0, min(255, q)) / 255.0
            green    = max(0, min(255,
                              int(60 + 195 * life * (0.35 + 0.65 * qf))))
            color    = f"#00{green:02x}33"
            c.create_oval(x - 1.5, y - 1.5, x + 1.5, y + 1.5,
                          fill=color, outline="")

        # Highlight the most recent sample with a beam line + bright dot.
        if samples:
            a, d, q = samples[-1]
            if 0 < d <= rng:
                ar = math.radians(a)
                rr = d * scale
                x  = cx + math.sin(ar) * rr
                y  = cy - math.cos(ar) * rr
                c.create_line(cx, cy, x, y, fill="#1d4a1d", width=1)
                c.create_oval(x - 3, y - 3, x + 3, y + 3,
                              fill="#fffd55", outline=GREEN, width=1)

    def _ring_step(self, rng):
        if rng <= 1.5:  return 0.25
        if rng <= 3.0:  return 0.5
        if rng <= 6.0:  return 1.0
        if rng <= 15.0: return 2.5
        return 5.0

    def _update_readout(self):
        with self._lock:
            a, d, q = self._last_angle, self._last_dist, self._last_quality
            rate    = len(self._sample_times) / RATE_WINDOW_S
            total   = self._sample_count
        self.lbl_readout.config(
            text=(f"angle={a:7.2f}°  dist={d:6.3f} m  quality={q:3d}  "
                  f"rate={rate:5.1f} Hz  samples={total}")
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _log(self, msg):
        self.lbl_err.config(text=msg)

    def _on_close(self):
        self._streaming = False
        if self._redraw_after_id is not None:
            try:
                self.after_cancel(self._redraw_after_id)
            except Exception:
                pass
        self.destroy()


if __name__ == "__main__":
    LidarApp().mainloop()
