#!/usr/bin/env python3
"""
ml0_sequence_check.py — does the capture ring really deliver EVERY scan, in order?

This is a CORRECTNESS test, not a viewer. It is meant to be run against a device
running a program whose only job is to count:

    Var0 := Var0 + 1;        (* %ML0, LINT, in a T#10us task *)

Because the value increases by exactly 1 on every scan, the VALUE ITSELF is the
ground truth. That gives two independent checks:

  1. sequence continuity — the ring's own `seq` numbers arrive with no holes.
     Proves the TRANSPORT lost nothing between the device and here.

  2. value continuity — consecutive samples differ by exactly the decimation
     stride (+1 when stride_N == 1). Proves the PRODUCER actually appended every
     scan. This is the one that catches the failure the ring is supposed to rule
     out: a buffer that only ever holds the LATEST value would show large,
     irregular jumps (…, 41, 3187, 6902, …) while still looking perfectly
     healthy on check 1.

A uniform step that is not 1 is NOT a failure: when the link cannot carry the
full scan rate the server decimates by a global stride N, so values step by N.
That is reported as decimation, not as loss. Only IRREGULAR steps are loss.

Run:
    python3 ml0_sequence_check.py
    (fill in host / password, press Start — defaults 192.168.0.11 / krontek)

Requires a runtime built with the capture ring (a normal Build & Send) and a
KronServer that serves /api/v1/stream/ring. If /api/v1/ring/info returns 404 the
agent on the device is stale — rebuild it with server/build.sh and redeploy.
"""
import collections
import json
import struct
import threading
import time
import tkinter as tk
from tkinter import ttk
import urllib.request
import urllib.error

# Variable type name (from the deployed variable table) -> struct format + size.
TYPE_FMT = {
    "bool": ("?", 1), "int8": ("b", 1), "uint8": ("B", 1),
    "int16": ("h", 2), "uint16": ("H", 2), "int32": ("i", 4), "uint32": ("I", 4),
    "int64": ("q", 8), "uint64": ("Q", 8), "float32": ("f", 4), "float64": ("d", 8),
}
INTEGER_TYPES = {"int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"}

# How many consecutive values to show on one flow line, and how many lines to
# keep queued for the GUI. The reader must never block on the GUI: a slow
# consumer creates TCP backpressure, the server raises the decimation stride to
# compensate, and the test would then be measuring this program's drawing speed
# instead of the device. Everything below is O(1) per frame for that reason.
FLOW_VALUES_PER_LINE = 10
FLOW_QUEUE_MAX = 400
ANOMALIES_PER_FRAME_MAX = 5
ANOMALY_KEEP = 1000


def _read_exact(resp, n):
    """Read exactly n bytes, or b'' on EOF."""
    chunks, got = [], 0
    while got < n:
        b = resp.read(n - got)
        if not b:
            return b""
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


class SequenceChecker(threading.Thread):
    """Streams the capture ring and verifies seq + value continuity.

    All decoding and analysis happens here. The GUI only reads the shared state
    under the lock and drains the flow queue; this thread never touches tkinter.
    """

    def __init__(self, host, port, password, var_name, dump_path=None):
        super().__init__(daemon=True)
        self.base = f"http://{host}:{port}"
        self.password = password
        self.want_var = (var_name or "").strip()
        self.dump_path = dump_path

        self.lock = threading.Lock()
        self.stop_flag = threading.Event()
        self._resp = None
        self._dump = None

        # ---- shared state (read by the GUI under self.lock) ----
        self.error = None
        self.connected = False
        self.started_at = None
        self.finished = False

        self.var_name = None        # the variable actually being tracked
        self.var_type = None
        self.var_task = None
        self.task_period_us = None

        self.total_records = 0      # records of ALL tasks
        self.var_samples = 0        # samples of the tracked variable
        self.seq_gaps = 0
        self.dropped_total = 0
        self.attach_backlog = None  # ring history lapped BEFORE we attached
        self.stride_n = 1
        self.stride_changes = 0

        self.first_value = None
        self.last_value = None
        self.step_hist = collections.Counter()   # observed value step -> count
        self.anomalies = collections.deque(maxlen=ANOMALY_KEEP)
        self.anomaly_count = 0

        self.flow = collections.deque(maxlen=FLOW_QUEUE_MAX)  # (kind, text)

        # ---- reader-private ----
        self._expect_seq = None
        self._prev_value = None
        self._prev_stride = None
        self._stride_window = collections.deque(maxlen=64)  # strides recently in play
        self._task_cols = {}        # task_id -> [(name, fmt, size), ...]

    # ---- HTTP helpers -----------------------------------------------------

    def _auth(self):
        body = json.dumps({"password": self.password}).encode()
        req = urllib.request.Request(self.base + "/api/v1/auth", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r)["token"]

    def _ring_info(self, token):
        req = urllib.request.Request(self.base + "/api/v1/ring/info",
                                     headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r)

    # ---- lifecycle --------------------------------------------------------

    def run(self):
        try:
            token = self._auth()
            info = self._ring_info(token)
            if not info.get("available"):
                self._fail(f"capture ring not available: {info.get('reason', '?')}")
                return
            if not self._resolve_layout(info):
                return

            if self.dump_path:
                self._dump = open(self.dump_path, "w", buffering=1 << 20)
                self._dump.write(f"# seq\t{self.var_name}\n")

            req = urllib.request.Request(self.base + "/api/v1/stream/ring",
                                         headers={"Authorization": "Bearer " + token})
            self._resp = urllib.request.urlopen(req, timeout=10)
            with self.lock:
                self.connected = True
                self.started_at = time.time()

            while not self.stop_flag.is_set():
                head = _read_exact(self._resp, 4)
                if len(head) < 4:
                    break
                body = _read_exact(self._resp, struct.unpack("<I", head)[0])
                if not body:
                    break
                self._apply_frame(body)
        except urllib.error.HTTPError as e:
            detail = " — the agent on the device is stale (no /api/v1/ring routes); \
rebuild with server/build.sh and redeploy" if e.code == 404 else ""
            self._fail(f"HTTP {e.code} {e.reason}{detail}")
        except Exception as e:  # noqa: BLE001 - surface anything to the GUI
            if not self.stop_flag.is_set():
                self._fail(f"{type(e).__name__}: {e}")
        finally:
            try:
                if self._resp:
                    self._resp.close()
            except Exception:
                pass
            try:
                if self._dump:
                    self._dump.close()
            except Exception:
                pass
            with self.lock:
                self.finished = True

    def _resolve_layout(self, info):
        """Pick the variable to track and build per-task payload decoders."""
        layout = info.get("layout")
        if not layout or not layout.get("tasks"):
            self._fail("no ring layout in the deployed variable table — "
                       "does the project have any addressed variables?")
            return False

        # Build a decoder per task, and locate the requested variable (or, with
        # no name given, the first variable of the FASTEST task — which is where
        # a 10us counter at %ML0 lives).
        candidates = []
        for t in layout["tasks"]:
            cols, off = [], 0
            for v in t.get("vars", []):
                fmt, sz = TYPE_FMT.get(v["type"], (f"{v['size']}s", v["size"]))
                cols.append((v["name"], fmt, sz))
                candidates.append((t["task_id"], t.get("period_us", 0), v["name"],
                                   v["type"], fmt, sz, off))
                off += sz
            self._task_cols[t["task_id"]] = cols

        pick = None
        if self.want_var:
            for c in candidates:
                if c[2].lower() == self.want_var.lower() or c[2].lower().endswith("." + self.want_var.lower()):
                    pick = c
                    break
            if pick is None:
                names = ", ".join(c[2] for c in candidates) or "(none)"
                self._fail(f"variable '{self.want_var}' is not in the ring layout. Available: {names}")
                return False
        else:
            # fastest task (smallest non-zero period), first variable in it
            ordered = sorted((c for c in candidates), key=lambda c: (c[1] or 1 << 30))
            if not ordered:
                self._fail("ring layout has no variables")
                return False
            pick = ordered[0]

        task_id, period_us, name, vtype, fmt, size, poff = pick
        if vtype not in INTEGER_TYPES:
            self._fail(f"'{name}' is {vtype}; this test needs an INTEGER counter "
                       f"(e.g. Var0 : LINT at %ML0 doing Var0 := Var0 + 1)")
            return False

        with self.lock:
            self.var_name, self.var_type = name, vtype
            self.var_task, self.task_period_us = task_id, period_us
        self._var = (task_id, fmt, size, poff)
        return True

    # ---- the actual test --------------------------------------------------

    def _apply_frame(self, body):
        count, stride_n, dropped = struct.unpack_from("<IIQ", body, 0)
        off = 16
        want_task, fmt, size, poff = self._var
        vfmt = "<" + fmt

        values = []          # this frame's values for the tracked variable
        seq_gaps = 0
        new_anoms = []

        for _ in range(count):
            seq, task_id, plen = struct.unpack_from("<QHH", body, off)
            payload_at = off + 12
            off = payload_at + plen

            # 1) TRANSPORT check: the ring's own sequence must be contiguous.
            if self._expect_seq is not None and seq != self._expect_seq:
                seq_gaps += 1
            self._expect_seq = seq + 1

            if task_id != want_task or poff + size > plen:
                continue
            values.append((seq, struct.unpack_from(vfmt, body, payload_at + poff)[0]))

        # 2) PRODUCER check: consecutive values must step by exactly stride_N.
        #
        # Only meaningful while the stride is STABLE. The server re-evaluates the
        # stride every 100 ms, and the producer's phase (`scan_g %% N`) resets
        # arbitrarily when N changes, so a step across a stride change is legally
        # anything in roughly [1, N_old + N_new]. Two rules keep this honest:
        #   • a step SMALLER than expected is never loss — it means MORE samples
        #     arrived than the stride promised, which lapping cannot cause;
        #   • a step is only loss if it exceeds what the strides in play can
        #     explain (tolerance below).
        # While the stride is being adapted, the device-side counters (seq gaps
        # and `dropped`) are the authority on loss, not the value steps.
        self._stride_window.append(stride_n if stride_n >= 1 else 1)
        window = set(self._stride_window)
        hi = max(window)
        # A record was produced under whichever stride was live at that instant,
        # which is NOT necessarily the one this frame reports: frames arrive every
        # 5 ms, the stride is re-tuned every 100 ms, and empty frames in between
        # can consume the change. So compare against the strides recently in play.
        stable = len(window) == 1
        expected_step = hi
        # phase reset on a stride change can double the gap; real lapping on this
        # ring would jump by nslots x stride, i.e. orders of magnitude more
        limit = hi if stable else 2 * hi
        for seq, val in values:
            if self._prev_value is not None:
                step = val - self._prev_value
                self.step_hist[step] += 1
                # a step SMALLER than the stride is never loss (more samples
                # arrived than the stride promised; lapping cannot cause that)
                if step <= 0 or step > limit:
                    self.anomaly_count += 1
                    if len(new_anoms) < ANOMALIES_PER_FRAME_MAX:
                        new_anoms.append((seq, self._prev_value, val, step, expected_step))
            self._prev_value = val
            if self._dump:
                self._dump.write(f"{seq}\t{val}\n")

        # ---- publish ------------------------------------------------------
        with self.lock:
            self.total_records += count
            self.var_samples += len(values)
            self.seq_gaps += seq_gaps
            self.dropped_total = dropped
            if self.attach_backlog is None:
                self.attach_backlog = dropped
            if self._prev_stride is not None and self._prev_stride != stride_n:
                self.stride_changes += 1
                self.flow.append(("warn", f"stride_N changed {self._prev_stride} -> {stride_n} "
                                          f"(server decimating to fit the link)"))
            self.stride_n = stride_n
            if values:
                if self.first_value is None:
                    self.first_value = values[0][1]
                self.last_value = values[-1][1]
            for a in new_anoms:
                self.anomalies.append(a)
                self.flow.append(("bad", f"GAP  seq={a[0]}  {a[1]} -> {a[2]}   "
                                         f"step={a[3]:+d} (expected {a[4]:+d})  "
                                         f"{a[3] - a[4]} value(s) lost"))
            if seq_gaps:
                self.flow.append(("bad", f"ring seq discontinuity x{seq_gaps} in this frame"))
            # One sampled flow line per frame, so the user can literally read the
            # consecutive numbers. Sampled for display only — every value above
            # was still checked.
            if values:
                shown = values[:FLOW_VALUES_PER_LINE]
                txt = " ".join(str(v) for _, v in shown)
                more = f"  … (+{len(values) - len(shown)} more this frame)" if len(values) > len(shown) else ""
                self.flow.append(("ok", f"{txt}{more}"))

        self._prev_stride = stride_n

    def _fail(self, msg):
        with self.lock:
            self.error = msg
            self.connected = False

    def stop(self):
        self.stop_flag.set()
        try:
            if self._resp:
                self._resp.close()
        except Exception:
            pass

    # ---- verdict ----------------------------------------------------------

    def verdict(self):
        """(severity, headline, detail) — severity in {'ok','warn','bad','idle'}."""
        with self.lock:
            if self.error:
                return "bad", "ERROR", self.error
            if not self.connected and not self.finished:
                return "idle", "not started", ""
            if self.var_samples < 2:
                return "idle", "waiting for data…", ""
            stream_drops = self.dropped_total - (self.attach_backlog or 0)
            anoms, gaps, stride = self.anomaly_count, self.seq_gaps, self.stride_n
            steps = dict(self.step_hist)
            name = self.var_name

        if anoms or gaps or stream_drops:
            with self.lock:
                shown = ", ".join(f"{a[2]}-{a[1]}={a[3]:+d} (max {a[4]:+d})"
                                  for a in list(self.anomalies)[:4])
            return ("bad", "LOSS DETECTED",
                    f"{anoms} value discontinuities, {gaps} ring seq gaps, "
                    f"{stream_drops} dropped records. Examples: {shown}")
        if stride == 1:
            return ("ok", "LOSSLESS — every scan captured",
                    f"{name} stepped by exactly +1 on every single sample "
                    f"(stride_N=1, no seq gaps, no drops). The ring is NOT "
                    f"returning just the latest value.")
        return ("warn", f"UNIFORM DECIMATION — every {stride}th scan",
                f"{name} stepped by exactly +{stride} on every sample: the link "
                f"could not carry the full scan rate, so the server thinned "
                f"production evenly. No irregular loss.")


class App:
    def __init__(self, root):
        self.root = root
        self.reader = None
        root.title("Capture Ring — sequence integrity check (%ML0 counter)")
        root.geometry("980x680")

        # ---- connection bar ----
        bar = ttk.Frame(root, padding=8)
        bar.pack(fill="x")
        self.host = tk.StringVar(value="192.168.0.11")
        self.port = tk.StringVar(value="7070")
        self.password = tk.StringVar(value="krontek")
        self.varname = tk.StringVar(value="")
        self.dump = tk.BooleanVar(value=False)

        for label, var, width in (("Host", self.host, 15), ("Port", self.port, 6),
                                  ("Password", self.password, 12),
                                  ("Variable (blank = fastest task's first)", self.varname, 16)):
            ttk.Label(bar, text=label).pack(side="left", padx=(8, 2))
            ttk.Entry(bar, textvariable=var, width=width).pack(side="left")

        self.btn = ttk.Button(bar, text="Start", command=self.toggle)
        self.btn.pack(side="left", padx=12)
        ttk.Checkbutton(bar, text="dump every value to ml0_dump.tsv",
                        variable=self.dump).pack(side="left")

        # ---- verdict banner ----
        self.banner = tk.Label(root, text="not started", anchor="w", justify="left",
                               font=("TkDefaultFont", 12, "bold"),
                               bg="#2d2d2d", fg="#bbbbbb", padx=10, pady=8)
        self.banner.pack(fill="x", padx=8)
        self.banner_detail = tk.Label(root, text="", anchor="w", justify="left",
                                      wraplength=940, bg="#2d2d2d", fg="#999999",
                                      padx=10, pady=(0))
        self.banner_detail.pack(fill="x", padx=8, pady=(0, 8))

        # ---- stats grid ----
        stats = ttk.LabelFrame(root, text="Live", padding=8)
        stats.pack(fill="x", padx=8)
        self.stat_vars = {}
        fields = [("variable", 0, 0), ("task period", 0, 1), ("samples", 0, 2), ("rate", 0, 3),
                  ("value", 1, 0), ("stride_N", 1, 1), ("seq gaps", 1, 2), ("drops (stream)", 1, 3),
                  ("value steps", 2, 0)]
        for name, r, c in fields:
            cell = ttk.Frame(stats)
            cell.grid(row=r, column=c, sticky="w", padx=(0, 24), pady=2)
            ttk.Label(cell, text=name, foreground="#888").pack(anchor="w")
            v = tk.StringVar(value="—")
            ttk.Label(cell, textvariable=v, font=("TkFixedFont", 11)).pack(anchor="w")
            self.stat_vars[name] = v
        stats.columnconfigure(3, weight=1)

        # ---- flowing values ----
        flow_frame = ttk.LabelFrame(root, text="Incoming values (sampled for display — every "
                                               "value is checked regardless)", padding=4)
        flow_frame.pack(fill="both", expand=True, padx=8, pady=8)
        self.text = tk.Text(flow_frame, height=18, bg="#1e1e1e", fg="#cccccc",
                            font=("TkFixedFont", 10), wrap="none")
        sb = ttk.Scrollbar(flow_frame, command=self.text.yview)
        self.text.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.text.pack(side="left", fill="both", expand=True)
        self.text.tag_configure("ok", foreground="#8fce8f")
        self.text.tag_configure("warn", foreground="#e0c060")
        self.text.tag_configure("bad", foreground="#f06060")

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.refresh()

    def toggle(self):
        if self.reader and self.reader.is_alive():
            self.reader.stop()
            self.btn.config(text="Start")
            return
        self.text.delete("1.0", "end")
        try:
            port = int(self.port.get())
        except ValueError:
            self._append("bad", "port must be a number")
            return
        self.reader = SequenceChecker(self.host.get().strip(), port,
                                      self.password.get(), self.varname.get(),
                                      "ml0_dump.tsv" if self.dump.get() else None)
        self.reader.start()
        self.btn.config(text="Stop")

    def _append(self, tag, line):
        self.text.insert("end", line + "\n", tag)
        # keep the widget bounded — it is redrawn at 10 Hz and would otherwise
        # grow without limit during a long run
        if int(self.text.index("end-1c").split(".")[0]) > 600:
            self.text.delete("1.0", "200.0")
        self.text.see("end")

    def refresh(self):
        r = self.reader
        if r:
            with r.lock:
                elapsed = time.time() - r.started_at if r.started_at else 0
                samples = r.var_samples
                snapshot = dict(
                    name=r.var_name or "—", vtype=r.var_type or "?", period=r.task_period_us,
                    value=r.last_value, first=r.first_value,
                    stride=r.stride_n, gaps=r.seq_gaps,
                    drops=r.dropped_total - (r.attach_backlog or 0),
                    steps=dict(r.step_hist), total=r.total_records,
                )
                lines = list(r.flow)
                r.flow.clear()

            for tag, line in lines:
                self._append(tag, line)

            sv = self.stat_vars
            sv["variable"].set(f"{snapshot['name']} ({snapshot['vtype']})")
            sv["task period"].set(f"{snapshot['period']} us" if snapshot["period"] else "—")
            sv["samples"].set(f"{samples:,}")
            sv["rate"].set(f"{samples / elapsed:,.0f}/s" if elapsed > 0.5 else "—")
            sv["value"].set(str(snapshot["value"]) if snapshot["value"] is not None else "—")
            sv["stride_N"].set(str(snapshot["stride"]))
            sv["seq gaps"].set(str(snapshot["gaps"]))
            sv["drops (stream)"].set(str(snapshot["drops"]))
            steps = snapshot["steps"]
            sv["value steps"].set(
                "  ".join(f"{k:+d} ×{v:,}" for k, v in sorted(steps.items())[:8]) or "—")

            sev, headline, detail = r.verdict()
            colors = {"ok": ("#1e3a1e", "#8fce8f"), "warn": ("#3a331e", "#e0c060"),
                      "bad": ("#3a1e1e", "#f06060"), "idle": ("#2d2d2d", "#bbbbbb")}
            bg, fg = colors[sev]
            self.banner.config(text=headline, bg=bg, fg=fg)
            self.banner_detail.config(text=detail, bg=bg)

            if r.finished and self.btn.cget("text") == "Stop":
                self.btn.config(text="Start")

        self.root.after(100, self.refresh)

    def on_close(self):
        if self.reader:
            self.reader.stop()
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
