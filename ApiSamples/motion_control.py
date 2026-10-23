#!/usr/bin/env python3
"""
motion_control.py — tkinter panel for the single-axis motion project
(PLC_Projects/motionrpi3bplus.xml): MC_Power, MC_Reset, MC_MoveAbsolute,
MC_MoveVelocity, MC_Halt and MC_Stop on Axis_1, every input/output exposed as an addressed
variable (%MX / %MW / %MD / %ML).

Each block gets its parameter fields, a command button and its status lamps
(Done/InVelocity, Busy, Active, CommandAborted, Error, ErrorID).

Command buttons:
  Move Abs / Move Vel / Halt
      write the parameters, then Execute FALSE -> TRUE. Every REST write
      returns only after the runtime applied it, so the two writes land in
      different scans and the FB is guaranteed to see the rising edge.
      Execute stays TRUE afterwards: its falling edge does not stop a motion
      (PLCopen Part 1 v2.0 §2.4.1), and with ContinuousUpdate it keeps the
      FB taking new parameters — "Apply" writes them without a new edge.
  Reset (in the MC_Power frame)
      a PULSE on MC_Reset.Execute: FALSE -> TRUE -> FALSE, three one-shot
      writes, each acked in its own scan, so the rising edge clears the
      axis error (ErrorStop -> Standstill) and Execute is left FALSE, ready for
      the next press. Fix the cause first, or the error returns.
  STOP
      a HELD command: PLCopen §3.3 keeps the axis in 'Stopping' — rejecting
      every other motion command — for as long as MC_Stop.Execute is TRUE.
      So the button latches; "Release STOP" writes Execute FALSE, and only
      then does the axis go back to Standstill.

Variables are resolved BY ADDRESS, not by name. Every REST write is ONE-SHOT
(KronServer has no forcing): a value stays only because the PLC logic reads
these inputs and never assigns them, so it outlives this window — but a
runtime restart brings back the project's initial values (Power_Enable too).
The axis' actual position is read from %ML137 (Actual_Position, LREAL) and
plotted against the set position (MC_MoveAbsolute.Position as read back from
the PLC) over the last CHART_WINDOW_S seconds. It is optional: a project
without it still connects, and the chart then shows only the set value.

Log start / Log stop: a 1 ms log of the set position (%ML40) and the actual
position (%ML137) read straight from the target's shared memory — an
out-of-band experiment that leaves the PLC untouched. "Log start" reads
the target's variable_table.json over SSH (key auth, --ssh-user/--ssh-port,
--remote-dir), cross-compiles shm_logger.c with the bundled clang, copies it
to /tmp on the target and runs it; its CSV streams back into
--log-dir/poslog_<date>_<time>.csv. "Log stop" closes the connection, which
ends the logger. The values only change as often as the logic task refreshes
the shm mirror (see shm_logger.c).

Usage:
    python3 motion_control.py --host 192.168.1.103 --password krontek
    python3 motion_control.py --pos-min 0 --pos-max 360
Keys: Esc = STOP, Space = Halt.

Position slider (floating point, ~100 000 steps across the range): with
ContinuousUpdate ticked and Move Abs executed once, a drag streams the target
to the running MC_MoveAbsolute (latest value only). "Move on change" instead
fires a Move Abs for every change — each worker cycle sends the LATEST slider
position plus an Execute FALSE -> TRUE edge, so the axis follows the slider
while it is dragged; the other parameters are written once when the drag starts.
"""
import argparse
import json
import math
import os
import queue
import shlex
import subprocess
from collections import deque
import threading
import time
import tkinter as tk
import urllib.error
from tkinter import ttk

from kron_client import KronClient, add_common_args

POLL_PERIOD_S = 0.1
CHART_WINDOW_S = 20.0
CHART_SET = "#2563eb"
CHART_ACT = "#ea580c"

# key -> (address, kind). kind: "bool", "int" (DINT), "real" (LREAL), "word".
VARS = {
    "Power_Enable":          ("%MX0.0", "bool"),
    "Power_EnablePositive":  ("%MX0.1", "bool"),
    "Power_EnableNegative":  ("%MX0.2", "bool"),
    "Power_Status":          ("%MX0.3", "bool"),
    "Power_Valid":           ("%MX0.4", "bool"),
    "Power_Error":           ("%MX0.5", "bool"),
    "Power_ErrorID":         ("%MW10", "word"),

    "Reset_Execute":         ("%MX5.0", "bool"),
    "Reset_Done":            ("%MX5.1", "bool"),
    "Reset_Busy":            ("%MX5.2", "bool"),
    "Reset_Error":           ("%MX5.3", "bool"),
    "Reset_ErrorID":         ("%MW6", "word"),

    "Abs_Execute":           ("%MX1.0", "bool"),
    "Abs_ContinuousUpdate":  ("%MX1.1", "bool"),
    "Abs_Done":              ("%MX1.2", "bool"),
    "Abs_Busy":              ("%MX1.3", "bool"),
    "Abs_Active":            ("%MX1.4", "bool"),
    "Abs_CommandAborted":    ("%MX1.5", "bool"),
    "Abs_Error":             ("%MX1.6", "bool"),
    "Abs_ErrorID":           ("%MW12", "word"),
    "Abs_Position":          ("%ML40", "real"),
    "Abs_Velocity":          ("%ML48", "real"),
    "Abs_Acceleration":      ("%ML56", "real"),
    "Abs_Deceleration":      ("%ML64", "real"),
    "Abs_Jerk":              ("%ML72", "real"),
    "Abs_Direction":         ("%MD20", "int"),
    "Abs_BufferMode":        ("%MD24", "int"),

    "Vel_Execute":           ("%MX2.0", "bool"),
    "Vel_ContinuousUpdate":  ("%MX2.1", "bool"),
    "Vel_InVelocity":        ("%MX2.2", "bool"),
    "Vel_Busy":              ("%MX2.3", "bool"),
    "Vel_Active":            ("%MX2.4", "bool"),
    "Vel_CommandAborted":    ("%MX2.5", "bool"),
    "Vel_Error":             ("%MX2.6", "bool"),
    "Vel_ErrorID":           ("%MW14", "word"),
    "Vel_Velocity":          ("%ML80", "real"),
    "Vel_Acceleration":      ("%ML88", "real"),
    "Vel_Deceleration":      ("%ML96", "real"),
    "Vel_Jerk":              ("%ML104", "real"),
    "Vel_Direction":         ("%MD28", "int"),
    "Vel_BufferMode":        ("%MD32", "int"),

    "Halt_Execute":          ("%MX3.0", "bool"),
    "Halt_Done":             ("%MX3.1", "bool"),
    "Halt_Busy":             ("%MX3.2", "bool"),
    "Halt_Active":           ("%MX3.3", "bool"),
    "Halt_CommandAborted":   ("%MX3.4", "bool"),
    "Halt_Error":            ("%MX3.5", "bool"),
    "Halt_ErrorID":          ("%MW16", "word"),
    "Halt_Deceleration":     ("%ML112", "real"),
    "Halt_Jerk":             ("%ML120", "real"),
    "Halt_BufferMode":       ("%MD36", "int"),

    "Stop_Execute":          ("%MX4.0", "bool"),
    "Stop_Done":             ("%MX4.1", "bool"),
    "Stop_Busy":             ("%MX4.2", "bool"),
    "Stop_Active":           ("%MX4.3", "bool"),
    "Stop_CommandAborted":   ("%MX4.4", "bool"),
    "Stop_Error":            ("%MX4.5", "bool"),
    "Stop_ErrorID":          ("%MW18", "word"),
    "Stop_Deceleration":     ("%ML128", "real"),
    "Stop_Jerk":             ("%ML136", "real"),

    "Actual_Position":       ("%ML137", "real"),
}
# Read-only extras: a project without them still connects.
OPTIONAL = {"Actual_Position"}

# KronMotion enums (resources/krontek-include/kron_axis.h).
DIRECTIONS = {"Positive": 1, "Shortest way": 2, "Negative": 3, "Current": 4}
BUFFER_MODES = {"Aborting": 0, "Buffered": 1, "BlendingLow": 2,
                "BlendingPrevious": 3, "BlendingNext": 4, "BlendingHigh": 5}

# Per block: parameters (key, label, widget) and status lamps (key, label).
# widget: "real" entry, "slider" scale + entry, "dir"/"buf" combobox,
# "check" checkbutton.
BLOCKS = {
    "Abs": {
        "title": "MC_MoveAbsolute",
        "params": [("Abs_Position", "Position", "slider"),
                   ("Abs_Velocity", "Velocity", "real"),
                   ("Abs_Acceleration", "Acceleration", "real"),
                   ("Abs_Deceleration", "Deceleration", "real"),
                   ("Abs_Jerk", "Jerk", "real"),
                   ("Abs_Direction", "Direction", "dir"),
                   ("Abs_BufferMode", "BufferMode", "buf"),
                   ("Abs_ContinuousUpdate", "ContinuousUpdate", "check")],
        "lamps": [("Abs_Done", "Done"), ("Abs_Busy", "Busy"), ("Abs_Active", "Active"),
                  ("Abs_CommandAborted", "Aborted"), ("Abs_Error", "Error")],
        "button": "Move Abs",
    },
    "Vel": {
        "title": "MC_MoveVelocity",
        "params": [("Vel_Velocity", "Velocity (signed)", "real"),
                   ("Vel_Acceleration", "Acceleration", "real"),
                   ("Vel_Deceleration", "Deceleration", "real"),
                   ("Vel_Jerk", "Jerk", "real"),
                   ("Vel_Direction", "Direction", "dir"),
                   ("Vel_BufferMode", "BufferMode", "buf"),
                   ("Vel_ContinuousUpdate", "ContinuousUpdate", "check")],
        "lamps": [("Vel_InVelocity", "InVelocity"), ("Vel_Busy", "Busy"),
                  ("Vel_Active", "Active"), ("Vel_CommandAborted", "Aborted"),
                  ("Vel_Error", "Error")],
        "button": "Move Vel",
    },
    "Halt": {
        "title": "MC_Halt",
        "params": [("Halt_Deceleration", "Deceleration", "real"),
                   ("Halt_Jerk", "Jerk", "real"),
                   ("Halt_BufferMode", "BufferMode", "buf")],
        "lamps": [("Halt_Done", "Done"), ("Halt_Busy", "Busy"), ("Halt_Active", "Active"),
                  ("Halt_CommandAborted", "Aborted"), ("Halt_Error", "Error")],
        "button": "Halt",
    },
    "Stop": {
        "title": "MC_Stop",
        "params": [("Stop_Deceleration", "Deceleration", "real"),
                   ("Stop_Jerk", "Jerk", "real")],
        "lamps": [("Stop_Done", "Done"), ("Stop_Busy", "Busy"), ("Stop_Active", "Active"),
                  ("Stop_CommandAborted", "Aborted"), ("Stop_Error", "Error")],
        "button": "STOP",
    },
}

LAMP_ON = {"Error": "#dc2626", "Aborted": "#d97706"}   # default on-colour: green
LAMP_ON_DEFAULT = "#16a34a"
LAMP_OFF = "#d1d5db"


def coerce(kind, value):
    if kind == "bool":
        return bool(value)
    if kind in ("int", "word"):
        return int(value)
    return float(value)


class Worker(threading.Thread):
    """Owns the HTTP client; the Tk thread never blocks on the network.

    Commands run strictly in order, one write at a time, so a sequence like
    "parameters, Execute FALSE, Execute TRUE" reaches the PLC in that order and
    in separate scans (each write returns after the runtime's ACK).
    """

    def __init__(self, events):
        super().__init__(daemon=True)
        self.events = events              # -> Tk thread: (kind, payload)
        self.cmds = queue.Queue()         # <- Tk thread: (kind, payload)
        self.client = None
        self.names = {}                   # key -> PLC variable name
        self.latest = {}                  # key -> value, coalesced (slider drag)
        self.latest_move = None           # (label, params, exec_key), coalesced
        self.lock = threading.Lock()

    def post(self, kind, payload=None):
        self.cmds.put((kind, payload))

    def set_latest(self, key, value):
        """Live value from a slider: only the LATEST one per key is sent, so a
        fast drag never queues a backlog of stale positions."""
        with self.lock:
            self.latest[key] = value

    def set_latest_move(self, payload):
        """'Move on change': only the LATEST pending move is executed."""
        with self.lock:
            self.latest_move = payload

    def run(self):
        last_poll = 0.0
        while True:
            try:
                kind, payload = self.cmds.get(timeout=0.05)
                if kind == "quit":
                    return
                self._dispatch(kind, payload)
            except queue.Empty:
                pass
            if self.client:
                with self.lock:
                    latest, self.latest = self.latest, {}
                    move, self.latest_move = self.latest_move, None
                if latest:
                    self._dispatch("write", list(latest.items()))
                if move:
                    self._dispatch("execute", move + (True,))
            if not self.client or time.monotonic() - last_poll < POLL_PERIOD_S:
                continue
            last_poll = time.monotonic()
            try:
                values = self._authed(self.client.variables)
                self.events.put(("values", {k: values.get(n) for k, n in self.names.items()}))
            except Exception as e:  # noqa: BLE001 — surface anything to the UI
                self.client = None
                self.events.put(("lost", f"connection lost: {e}"))

    def _authed(self, fn):
        """Run fn; on 401 re-authenticate ONCE and retry (tokens expire, and a
        deploy that changes the API password revokes them)."""
        try:
            return fn()
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            self.client.auth()
            return fn()

    def _write(self, key, value):
        name = self.names[key]
        value = coerce(VARS[key][1], value)
        self._authed(lambda: self.client.write(name, value))

    def _dispatch(self, kind, payload):
        try:
            if kind == "connect":
                host, port, password = payload
                c = KronClient(host, port, password)
                c.auth()
                by_addr = {}
                for name in c.variables():
                    addr = c.variable(name).get("address", "")
                    by_addr[addr.upper()] = name
                missing = [f"{k} {a}" for k, (a, _) in VARS.items()
                           if a not in by_addr and k not in OPTIONAL]
                if missing:
                    raise RuntimeError("not on the PLC: " + ", ".join(missing[:6])
                                       + (" …" if len(missing) > 6 else "")
                                       + " — wrong project deployed?")
                self.client = c
                self.names = {k: by_addr[a] for k, (a, _) in VARS.items() if a in by_addr}
                values = c.variables()
                self.events.put(("connected", {
                    "base": c.base, "running": c.runtime().get("running"),
                    "absent": [f"{k} {VARS[k][0]}" for k in OPTIONAL if k not in self.names],
                    "values": {k: values.get(n) for k, n in self.names.items()}}))
            elif not self.client:
                raise RuntimeError("not connected")
            elif kind == "disconnect":
                self.client = None
                self.events.put(("disconnected", None))
            elif kind == "write":                     # [(key, value), ...]
                for key, value in payload:
                    self._write(key, value)
            elif kind == "execute":                   # (label, params, exec_key[, quiet])
                label, params, exec_key, *quiet = payload
                for key, value in params:
                    self._write(key, value)
                self._write(exec_key, False)
                self._write(exec_key, True)
                if not quiet:
                    self.events.put(("info", f"{label}: Execute rising edge sent"))
            elif kind == "pulse":                     # (label, key)
                # Each write is acked once the runtime applied it, so the three
                # land in different scans and the FB sees TRUE for >= 1 scan.
                label, key = payload
                for value in (False, True, False):
                    self._write(key, value)
                self.events.put(("info", f"{label}: Execute pulse sent"))
            elif kind == "start":
                self._authed(self.client.start)
                self.events.put(("info", "runtime started"))
            elif kind == "stop_runtime":
                self._authed(self.client.stop)
                self.events.put(("info", "runtime stopped"))
        except urllib.error.HTTPError as e:
            # The server's {"error": "..."} says what happened; the status code
            # alone does not (503 is both "mailbox full" and "no API password").
            try:
                msg = json.loads(e.read()).get("error") or e.reason
            except Exception:  # noqa: BLE001 — body missing or not JSON
                msg = e.reason
            self.events.put(("error", f"{kind}: HTTP {e.code} — {msg}"))
        except Exception as e:  # noqa: BLE001
            self.events.put(("error", f"{kind}: {e}"))


class ShmLog:
    """Runs shm_logger (C, ApiSamples/shm_logger.c) on the target over SSH, its
    stdout going straight into a local CSV. Stop = close the SSH stdin: the
    logger ends on EOF, so a lost connection never leaves it sampling.

    The targets are BusyBox systems with no Python, so the sampler is
    cross-compiled here with the bundled clang (per target arch, cached in
    ApiSamples/build/) and copied to /tmp on every start. Offsets come from the
    target's own variable_table.json, resolved BY ADDRESS like the panel."""

    HERE = os.path.dirname(os.path.abspath(__file__))
    SOURCE = os.path.join(HERE, "shm_logger.c")
    REMOTE_BIN = "/tmp/kron_shm_logger"
    # uname -m -> (clang triple, extra flags) — mirrors toolchains/clang-command-templates.json.
    ARCHES = {
        "aarch64": ("aarch64-linux-gnu", ["-Wl,--dynamic-linker=/lib/ld-linux-aarch64.so.1"]),
        "armv7l": ("arm-linux-gnueabihf", ["-mfloat-abi=hard", "-mfpu=neon",
                                           "-Wl,--dynamic-linker=/lib/ld-linux-armhf.so.3"]),
        "x86_64": ("x86_64-linux-gnu", []),
    }
    TYPES = {"bool", "int8", "uint8", "int16", "uint16", "int32", "uint32",
             "int64", "uint64", "float32", "float64"}

    def __init__(self, events, args):
        self.events = events
        self.args = args
        self.proc = None
        self.busy = False          # setup (table, build, upload) or recording
        self.cancel = False

    def _ssh(self, host, *remote, stdin=None, timeout=20):
        cmd = ["ssh", "-p", str(self.args.ssh_port), "-o", "BatchMode=yes",
               "-o", "ConnectTimeout=5", f"{self.args.ssh_user}@{host}", *remote]
        r = subprocess.run(cmd, input=stdin, capture_output=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"ssh {' '.join(remote)[:40]}: "
                               + (r.stderr.decode(errors="replace").strip() or f"exit {r.returncode}"))
        return r.stdout

    def _build(self, arch):
        if arch not in self.ARCHES:
            raise RuntimeError(f"no build recipe for target arch '{arch}'")
        triple, extra = self.ARCHES[arch]
        out = os.path.join(self.HERE, "build", f"shm_logger-{triple}")
        if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(self.SOURCE):
            return out
        tc = os.path.abspath(self.args.toolchain)
        clang = os.path.join(tc, "bin", "clang")
        if not os.path.exists(clang):
            raise RuntimeError(f"bundled clang not found: {clang} (--toolchain)")
        resdir = next(iter(sorted(os.listdir(os.path.join(tc, "lib", "clang")))), "")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cmd = [clang, f"--target={triple}", f"--sysroot={os.path.join(tc, 'sysroots', triple)}",
               "-resource-dir", os.path.join(tc, "lib", "clang", resdir), "-fuse-ld=lld",
               "-O2", "-Wall", "-Wextra", "-s", *extra, self.SOURCE, "-lpthread", "-o", out]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("building shm_logger failed: " + r.stderr.strip()[-400:])
        return out

    def start(self, host, wanted, log_dir):
        """wanted: [(column name, IEC address)]. Runs the setup in a thread;
        reports ("log_started", info) or ("log_done", (path, code, message))."""
        self.busy, self.cancel = True, False
        threading.Thread(target=self._start, args=(host, wanted, log_dir), daemon=True).start()

    def _start(self, host, wanted, log_dir):
        try:
            raw = self._ssh(host, "uname -m; cat "
                            + shlex.quote(self.args.remote_dir.rstrip("/") + "/variable_table.json"))
            arch, _, table = raw.decode().partition("\n")
            by_addr = {v.get("address", "").upper(): v
                       for v in json.loads(table)["variables"] if v.get("address")}
            cols, desc = [], []
            for col, addr in wanted:
                v = by_addr.get(addr.upper())
                if v is None:
                    raise RuntimeError(f"{addr} is not in the target's variable table "
                                       "— wrong project deployed?")
                if v["type"] not in self.TYPES:
                    raise RuntimeError(f"{addr} ({v['name']}): type {v['type']} cannot be logged")
                cols.append(f"{col}:{v['offset']}:{v['type']}")
                desc.append(f"{col}={v['name']}")
            binary = self._build(arch.strip())
            with open(binary, "rb") as f:
                self._ssh(host, f"cat > {self.REMOTE_BIN} && chmod +x {self.REMOTE_BIN}",
                          stdin=f.read())
            if self.cancel:
                raise RuntimeError("cancelled")
            os.makedirs(log_dir, exist_ok=True)
            path = os.path.abspath(os.path.join(log_dir, time.strftime("poslog_%Y%m%d_%H%M%S.csv")))
            remote = " ".join([self.REMOTE_BIN, "--stop-on-stdin-eof",
                               "--shm", shlex.quote(f"/dev/shm/{self.args.shm_name}"),
                               "--period-us", str(int(self.args.log_period_ms * 1000)),
                               *map(shlex.quote, cols)])
            cmd = ["ssh", "-p", str(self.args.ssh_port), "-o", "BatchMode=yes",
                   "-o", "ConnectTimeout=5", f"{self.args.ssh_user}@{host}", remote]
            with open(path, "w") as out:
                self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=out,
                                             stderr=subprocess.PIPE, text=True)
        except Exception as e:  # noqa: BLE001 — surface anything to the UI
            self.busy = False
            self.events.put(("log_done", (None, 1, str(e))))
            return
        self.events.put(("log_started", (path, ", ".join(desc))))
        if self.cancel:
            self.stop()
        err = self.proc.stderr.read().strip()
        code = self.proc.wait()
        self.busy = False
        self.events.put(("log_done", (path, code, err.splitlines()[-1] if err else "")))

    def stop(self):
        self.cancel = True
        if self.proc is not None and self.proc.poll() is None and not self.proc.stdin.closed:
            self.proc.stdin.close()


class App:
    def __init__(self, root, args):
        self.root = root
        self.args = args
        self._pos_ignore = None   # slider value set from code, not by a drag
        self.status = tk.StringVar(value="not connected")
        self.events = queue.Queue()
        self.worker = Worker(self.events)
        self.worker.start()
        self.shm_log = ShmLog(self.events, args)
        self.connected = False
        self.stop_held = False
        self.fields = {}       # key -> (tk var, widget kind)
        self.lamps = {}        # key -> (label widget, lamp label)
        self.err_ids = {}      # block -> StringVar
        self.history = deque()  # (t, set position, actual position)

        root.title("KronMotion — Axis_1")
        pad = {"padx": 8, "pady": 4}

        # ── connection ──
        conn = ttk.LabelFrame(root, text="KronServer")
        conn.pack(fill="x", **pad)
        self.host = tk.StringVar(value=args.host)
        self.port = tk.StringVar(value=str(args.port))
        self.pw = tk.StringVar(value=args.password)
        for col, (label, var, width, show) in enumerate([
                ("Host", self.host, 16, ""), ("Port", self.port, 6, ""),
                ("Password", self.pw, 12, "*")]):
            ttk.Label(conn, text=label).grid(row=0, column=col * 2, padx=(6, 2), pady=6)
            ttk.Entry(conn, textvariable=var, width=width, show=show).grid(
                row=0, column=col * 2 + 1, pady=6)
        self.btn_conn = ttk.Button(conn, text="Connect", command=self.toggle_connect)
        self.btn_conn.grid(row=0, column=6, padx=6)
        rt = ttk.Frame(conn)
        rt.grid(row=1, column=0, columnspan=7, sticky="w", padx=6, pady=(0, 6))
        ttk.Button(rt, text="Runtime start", command=lambda: self.worker.post("start")).pack(side="left")
        ttk.Button(rt, text="Runtime stop",
                   command=lambda: self.worker.post("stop_runtime")).pack(side="left", padx=6)
        ttk.Separator(rt, orient="vertical").pack(side="left", fill="y", padx=10)
        self.btn_log_start = ttk.Button(rt, text="Log start", command=self.log_start)
        self.btn_log_start.pack(side="left")
        self.btn_log_stop = ttk.Button(rt, text="Log stop", command=self.log_stop,
                                       state="disabled")
        self.btn_log_stop.pack(side="left", padx=6)
        self.log_status = tk.StringVar(value="shm log: idle")
        ttk.Label(rt, textvariable=self.log_status).pack(side="left")

        # ── power ──
        pw = ttk.LabelFrame(root, text="MC_Power")
        pw.pack(fill="x", **pad)
        for col, (key, label) in enumerate([("Power_Enable", "Enable"),
                                            ("Power_EnablePositive", "EnablePositive"),
                                            ("Power_EnableNegative", "EnableNegative")]):
            var = tk.BooleanVar(value=False)
            self.fields[key] = (var, "check")
            ttk.Checkbutton(pw, text=label, variable=var,
                            command=lambda k=key, v=var: self.write([(k, v.get())])).grid(
                row=0, column=col, padx=6, pady=4, sticky="w")
        self._lamp_row(pw, 1, "Power", [("Power_Status", "Status"), ("Power_Valid", "Valid"),
                                        ("Power_Error", "Error")], "Power_ErrorID", span=3)
        ttk.Button(pw, text="Reset", command=self.reset).grid(
            row=2, column=0, padx=6, pady=(0, 4), sticky="w")
        self._lamp_row(pw, 2, "Reset", [("Reset_Done", "Done"), ("Reset_Busy", "Busy"),
                                        ("Reset_Error", "Error")], "Reset_ErrorID", span=2, column=1)

        # ── motion blocks, 2 x 2 ──
        grid = ttk.Frame(root)
        grid.pack(fill="both", expand=True, **pad)
        self.cmd_buttons = {}
        for i, (block, spec) in enumerate(BLOCKS.items()):
            r, c = divmod(i, 2)
            frame = ttk.LabelFrame(grid, text=spec["title"])
            frame.grid(row=r, column=c, sticky="nsew", padx=4, pady=4)
            grid.columnconfigure(c, weight=1)
            self._block(frame, block, spec)

        # ── position chart ──
        ch = ttk.LabelFrame(root, text="Position — set vs. actual")
        ch.pack(fill="both", expand=True, **pad)
        self.chart = tk.Canvas(ch, height=200, bg="white", highlightthickness=0)
        self.chart.pack(fill="both", expand=True, padx=4, pady=4)
        self.chart.bind("<Configure>", lambda _e: self.draw_chart())

        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w").pack(
            fill="x", side="bottom")

        root.bind("<Escape>", lambda e: self.stop_press(engage_only=True))
        root.bind("<space>", lambda e: None if self._typing() else self.execute("Halt"))
        root.protocol("WM_DELETE_WINDOW", self.quit)
        root.after(50, self.pump)

    # ── layout helpers ──
    def _block(self, frame, block, spec):
        row = 0
        for key, label, widget in spec["params"]:
            if widget == "slider":
                var = tk.StringVar(value="0")
                self.fields[key] = (var, widget)
                row = self._slider(frame, row, block, key, label, var)
                continue
            if widget == "check":
                var = tk.BooleanVar(value=False)
                ttk.Checkbutton(frame, text=label, variable=var,
                                command=lambda k=key, v=var: self.write([(k, v.get())])).grid(
                    row=row, column=0, columnspan=2, sticky="w", padx=6, pady=2)
            else:
                ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", padx=6, pady=2)
                if widget == "real":
                    var = tk.StringVar(value="0.0")
                    ent = ttk.Entry(frame, textvariable=var, width=12, justify="right")
                    ent.bind("<Return>", lambda e, b=block: self.apply(b))
                else:
                    choices = DIRECTIONS if widget == "dir" else BUFFER_MODES
                    var = tk.StringVar(value=next(iter(choices)))
                    ent = ttk.Combobox(frame, textvariable=var, values=list(choices),
                                       state="readonly", width=16)
                ent.grid(row=row, column=1, sticky="ew", padx=6, pady=2)
            self.fields[key] = (var, widget)
            row += 1
        frame.columnconfigure(1, weight=1)

        btns = ttk.Frame(frame)
        btns.grid(row=row, column=0, columnspan=2, sticky="ew", padx=6, pady=(6, 2))
        if block == "Stop":
            b = tk.Button(btns, text="STOP  (Esc)", bg="#dc2626", fg="white",
                          activebackground="#b91c1c", font=("TkDefaultFont", 10, "bold"),
                          command=self.stop_press)
        else:
            b = ttk.Button(btns, text=spec["button"] + ("  (Space)" if block == "Halt" else ""),
                           command=lambda bl=block: self.execute(bl))
        b.pack(side="left", fill="x", expand=True)
        self.cmd_buttons[block] = b
        ttk.Button(btns, text="Apply", width=6,
                   command=lambda bl=block: self.apply(bl)).pack(side="left", padx=(6, 0))
        self._lamp_row(frame, row + 1, block, spec["lamps"], f"{block}_ErrorID", span=2)

    def _slider(self, frame, row, block, key, label, var):
        """Position slider over an editable [min, max] range, plus an entry for
        an exact value. With ContinuousUpdate on (and Move Abs executed) a drag
        streams the position to the running FB; 'Move on change' instead
        executes a Move Abs to the latest position every worker cycle.
        Returns the next row."""
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", padx=6, pady=2)
        top = ttk.Frame(frame)
        top.grid(row=row, column=1, sticky="ew", padx=6, pady=2)
        ent = ttk.Entry(top, textvariable=var, width=12, justify="right")
        ent.pack(side="left")
        self.move_on_change = tk.BooleanVar(value=False)
        ttk.Checkbutton(top, text="Move on change",
                        variable=self.move_on_change).pack(side="left", padx=(8, 0))

        rng = ttk.Frame(frame)
        rng.grid(row=row + 1, column=0, columnspan=2, sticky="ew", padx=6, pady=(0, 4))
        self.pos_min = tk.StringVar(value=f"{self.args.pos_min:g}")
        self.pos_max = tk.StringVar(value=f"{self.args.pos_max:g}")
        e_min = ttk.Entry(rng, textvariable=self.pos_min, width=8, justify="right")
        e_min.pack(side="left")
        scale = tk.Scale(rng, orient="horizontal", showvalue=False, length=260)
        scale.pack(side="left", fill="x", expand=True, padx=4)
        e_max = ttk.Entry(rng, textvariable=self.pos_max, width=8, justify="right")
        e_max.pack(side="left")
        self.pos_scale = scale

        def on_drag(value):
            # Tk runs this callback at idle time, also after a .set() from
            # code — skip the one carrying the value sync_slider put there.
            if self._pos_ignore is not None and float(value) == self._pos_ignore:
                self._pos_ignore = None
                return
            var.set(f"{float(value):g}")
            if not self.connected:
                return
            if self.move_on_change.get():
                exec_key = f"{block}_Execute"
                self.worker.set_latest_move((BLOCKS[block]["title"], [(key, float(value))], exec_key))
                return
            cont, _ = self.fields[f"{block}_ContinuousUpdate"]
            if cont.get():
                self.worker.set_latest(key, float(value))

        def on_press(_e):
            # The per-change moves carry only the position: write the rest of
            # the form (velocity, acceleration, ...) once when a drag begins.
            if self.connected and self.move_on_change.get():
                self.apply(block)

        def on_entry(_e):
            try:
                self.sync_slider(float(var.get()))
            except ValueError:
                pass
            if self.move_on_change.get():
                self.execute(block)
            else:
                self.apply(block)

        scale.config(command=on_drag)
        scale.bind("<ButtonPress-1>", on_press)
        ent.bind("<Return>", on_entry)
        for e in (e_min, e_max):
            e.bind("<Return>", lambda _e: self.set_pos_range())
            e.bind("<FocusOut>", lambda _e: self.set_pos_range())
        self.set_pos_range()
        return row + 2

    def set_pos_range(self):
        try:
            lo, hi = float(self.pos_min.get()), float(self.pos_max.get())
        except ValueError:
            self.status.set("position range: min/max must be numbers")
            return
        if hi <= lo:
            self.status.set("position range: max must be greater than min")
            return
        # Floating point: ~100 000 steps across the range, rounded to a power
        # of ten (e.g. 0.01 for -1000..1000).
        res = 10 ** math.floor(math.log10((hi - lo) / 100000))
        self.pos_scale.config(from_=lo, to=hi, resolution=res)
        self._pos_ignore = float(self.pos_scale.get())
        try:
            self.sync_slider(float(self.fields["Abs_Position"][0].get()))
        except ValueError:
            pass

    def sync_slider(self, value):
        """Move the slider to value without treating it as a user drag; widen
        the range if the value lies outside it."""
        lo, hi = float(self.pos_scale.cget("from")), float(self.pos_scale.cget("to"))
        if value < lo or value > hi:
            self.pos_min.set(f"{min(lo, value):g}")
            self.pos_max.set(f"{max(hi, value):g}")
            self.pos_scale.config(from_=min(lo, value), to=max(hi, value))
        self.pos_scale.set(value)
        self._pos_ignore = float(self.pos_scale.get())

    def _lamp_row(self, parent, row, block, lamps, err_key, span, column=0):
        box = ttk.Frame(parent)
        box.grid(row=row, column=column, columnspan=span, sticky="w", padx=6, pady=(2, 6))
        for key, label in lamps:
            w = tk.Label(box, text=label, bg=LAMP_OFF, width=len(label) + 1,
                         relief="groove", font=("TkDefaultFont", 8))
            w.pack(side="left", padx=1)
            self.lamps[key] = (w, label)
        var = tk.StringVar(value="ErrorID —")
        ttk.Label(box, textvariable=var, font=("TkFixedFont", 9)).pack(side="left", padx=(6, 0))
        self.err_ids[err_key] = var

    # ── reading the form ──
    def _typing(self):
        return isinstance(self.root.focus_get(), (tk.Entry, ttk.Entry))

    def params(self, block):
        """[(key, value)] for the block's parameters; raises ValueError on a bad number."""
        out = []
        for key, label, widget in BLOCKS[block]["params"]:
            var, _ = self.fields[key]
            if widget in ("real", "slider"):
                try:
                    out.append((key, float(var.get())))
                except ValueError:
                    raise ValueError(f"{BLOCKS[block]['title']}.{label}: '{var.get()}' is not a number")
            elif widget == "dir":
                out.append((key, DIRECTIONS[var.get()]))
            elif widget == "buf":
                out.append((key, BUFFER_MODES[var.get()]))
            else:
                out.append((key, var.get()))
        return out

    # ── actions ──
    def write(self, pairs):
        if not self.connected:
            self.status.set("not connected")
            return
        self.worker.post("write", pairs)

    def apply(self, block):
        """Write the parameters only — taken by a running FB with ContinuousUpdate,
        otherwise used at the next Execute edge."""
        try:
            self.write(self.params(block))
        except ValueError as e:
            self.status.set(str(e))

    def execute(self, block):
        if not self.connected:
            self.status.set("not connected")
            return
        if self.stop_held and block != "Stop":
            self.status.set("MC_Stop is held — the axis rejects motion until 'Release STOP'")
        try:
            params = self.params(block)
        except ValueError as e:
            self.status.set(str(e))
            return
        self.worker.post("execute", (BLOCKS[block]["title"], params, f"{block}_Execute"))

    def reset(self):
        """MC_Reset: Execute pulse (FALSE -> TRUE -> FALSE), no parameters."""
        if not self.connected:
            self.status.set("not connected")
            return
        self.worker.post("pulse", ("MC_Reset", "Reset_Execute"))

    def stop_press(self, engage_only=False):
        if not self.connected:
            self.status.set("not connected")
            return
        if self.stop_held and not engage_only:
            self.write([("Stop_Execute", False)])
            self.set_stop_held(False)
            self.status.set("MC_Stop released — axis returns to Standstill once Done")
            return
        self.execute("Stop")
        self.set_stop_held(True)

    def set_stop_held(self, held):
        self.stop_held = held
        self.cmd_buttons["Stop"].config(
            text="Release STOP" if held else "STOP  (Esc)",
            bg="#7f1d1d" if held else "#dc2626")

    def toggle_connect(self):
        if self.connected:
            self.worker.post("disconnect")
            return
        try:
            port = int(self.port.get())
        except ValueError:
            self.status.set("port must be a number")
            return
        self.status.set(f"connecting to {self.host.get()}:{port} …")
        self.worker.post("connect", (self.host.get().strip(), port, self.pw.get()))

    def log_start(self):
        if self.shm_log.busy:
            return
        self.btn_log_start.config(state="disabled")
        self.btn_log_stop.config(state="normal")
        self.log_status.set("shm log: preparing …")
        self.status.set("shm log: reading the variable table, building and uploading the sampler …")
        self.shm_log.start(self.host.get().strip(),
                           [("Abs_Position", "%ML40"), ("Actual_Position", "%ML137")],
                           self.args.log_dir)

    def log_stop(self):
        self.shm_log.stop()
        self.log_status.set("shm log: stopping …")

    def quit(self):
        self.shm_log.stop()
        self.worker.post("quit")
        self.worker.join(timeout=2)
        self.root.destroy()

    # ── worker → UI ──
    def pump(self):
        while True:
            try:
                kind, p = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "connected":
                self.connected = True
                self.btn_conn.config(text="Disconnect")
                self.load_fields(p["values"])
                self.set_stop_held(bool(p["values"].get("Stop_Execute")))
                run = "RUNNING" if p["running"] else "runtime STOPPED"
                note = (" — not on the PLC, not plotted: " + ", ".join(p["absent"])
                        if p["absent"] else "")
                self.status.set(f"connected {p['base']} — {run} — parameters loaded from the PLC{note}")
                self.history.clear()
                self.show(p["values"])
            elif kind in ("disconnected", "lost"):
                self.connected = False
                self.btn_conn.config(text="Connect")
                self.status.set("disconnected — written values stay on the PLC until its logic or a restart changes them"
                                if kind == "disconnected" else "error: " + p)
                for w, _ in self.lamps.values():
                    w.config(bg=LAMP_OFF)
                for v in self.err_ids.values():
                    v.set("ErrorID —")
            elif kind == "values":
                self.show(p)
            elif kind == "log_started":
                path, desc = p
                self.log_status.set(f"shm log: RECORDING → {os.path.basename(path)}")
                self.status.set(f"shm log: {desc} every {self.args.log_period_ms:g} ms → {path}")
            elif kind == "log_done":
                path, code, msg = p
                self.btn_log_start.config(state="normal")
                self.btn_log_stop.config(state="disabled")
                # msg is the logger's summary line (samples, late, max gap) on
                # success, otherwise the SSH / build / logger error.
                if code == 0:
                    self.log_status.set("shm log: idle")
                    self.status.set(f"shm log saved {path} — {msg}")
                else:
                    if path and os.path.exists(path) and os.path.getsize(path) == 0:
                        os.remove(path)   # never got as far as the header
                    self.log_status.set("shm log: FAILED")
                    self.status.set(f"shm log failed (exit {code}): {msg or 'no output'}")
            elif kind == "info":
                self.status.set(p)
            elif kind == "error":
                self.status.set("error: " + p)
        self.root.after(50, self.pump)

    def load_fields(self, values):
        """Fill the form from the PLC so the first command doesn't overwrite
        the program's initial values with this window's defaults."""
        dir_names = {v: k for k, v in DIRECTIONS.items()}
        buf_names = {v: k for k, v in BUFFER_MODES.items()}
        for key, (var, widget) in self.fields.items():
            v = values.get(key)
            if v is None:
                continue
            if widget == "real":
                var.set(f"{float(v):g}")
            elif widget == "slider":
                var.set(f"{float(v):g}")
                self.sync_slider(float(v))
            elif widget == "dir":
                var.set(dir_names.get(int(v), "Positive"))
            elif widget == "buf":
                var.set(buf_names.get(int(v), "Aborting"))
            else:
                var.set(bool(v))

    def show(self, values):
        for key, (w, label) in self.lamps.items():
            on = bool(values.get(key))
            w.config(bg=LAMP_ON.get(label, LAMP_ON_DEFAULT) if on else LAMP_OFF,
                     fg="white" if on else "black")
        for key, var in self.err_ids.items():
            v = values.get(key)
            var.set("ErrorID —" if v is None else f"ErrorID 0x{int(v):04X}")
        now = time.monotonic()
        self.history.append((now, values.get("Abs_Position"), values.get("Actual_Position")))
        while self.history and self.history[0][0] < now - CHART_WINDOW_S:
            self.history.popleft()
        self.draw_chart()

    def draw_chart(self):
        """Set position and actual position over the last CHART_WINDOW_S seconds,
        y axis auto-scaled to the visible samples."""
        c = self.chart
        c.delete("all")
        w, h = c.winfo_width(), c.winfo_height()
        left, right, top, bottom = 64, 10, 22, 18
        pw, ph = w - left - right, h - top - bottom
        if pw < 20 or ph < 20:
            return
        ys = [float(v) for _, sp, act in self.history for v in (sp, act) if v is not None]
        if not ys:
            c.create_text(w / 2, h / 2, text="no data", fill="#9ca3af")
            return
        lo, hi = min(ys), max(ys)
        span = hi - lo
        if span < 1e-9:
            span = max(abs(hi), 1.0) * 0.1
            lo, hi = lo - span / 2, hi + span / 2
        else:
            lo, hi = lo - span * 0.05, hi + span * 0.05
        t_end = time.monotonic()

        def x(t):
            return left + pw * (1 - (t_end - t) / CHART_WINDOW_S)

        def y(v):
            return top + ph * (hi - v) / (hi - lo)

        for i in range(5):
            v = lo + (hi - lo) * i / 4
            c.create_line(left, y(v), left + pw, y(v), fill="#e5e7eb")
            c.create_text(left - 4, y(v), text=f"{v:.4g}", anchor="e",
                          fill="#6b7280", font=("TkDefaultFont", 8))
        for s in range(0, int(CHART_WINDOW_S) + 1, 5):
            c.create_text(x(t_end - s), top + ph + 3, text=f"-{s}s" if s else "now",
                          anchor="n", fill="#6b7280", font=("TkDefaultFont", 8))
        c.create_rectangle(left, top, left + pw, top + ph, outline="#9ca3af")

        legend_x = left
        for idx, colour, name in ((1, CHART_SET, "Set"), (2, CHART_ACT, "Actual")):
            seg = []
            for sample in self.history:
                v = sample[idx]
                if v is None:           # gap: unavailable or not connected
                    if len(seg) >= 4:
                        c.create_line(*seg, fill=colour, width=2)
                    seg = []
                    continue
                seg += [x(sample[0]), y(float(v))]
            if len(seg) >= 4:
                c.create_line(*seg, fill=colour, width=2)
            last = next((s[idx] for s in reversed(self.history) if s[idx] is not None), None)
            text = f"{name}: " + ("—" if last is None else f"{float(last):.4f}")
            c.create_line(legend_x, 11, legend_x + 16, 11, fill=colour, width=2)
            t = c.create_text(legend_x + 20, 11, text=text, anchor="w",
                              font=("TkDefaultFont", 9))
            legend_x = c.bbox(t)[2] + 16


def main():
    ap = add_common_args(argparse.ArgumentParser(description=__doc__,
                                                 formatter_class=argparse.RawDescriptionHelpFormatter))
    ap.set_defaults(host="192.168.1.103")   # plcAddress of motionrpi3bplus.xml
    ap.add_argument("--pos-min", type=float, default=-1000.0,
                    help="position slider minimum (editable in the window)")
    ap.add_argument("--pos-max", type=float, default=1000.0,
                    help="position slider maximum (editable in the window)")
    ap.add_argument("--ssh-user", default="root", help="SSH user for the shm log (key auth)")
    ap.add_argument("--ssh-port", type=int, default=22)
    ap.add_argument("--log-dir", default=".", help="where the shm log CSVs are written")
    ap.add_argument("--log-period-ms", type=float, default=1.0,
                    help="shm log sample period on the target")
    ap.add_argument("--remote-dir", default="/home/root/plc",
                    help="KronServer's -deploy-dir on the target (holds variable_table.json)")
    ap.add_argument("--shm-name", default="plc_runtime", help="KronServer's -shm-name")
    ap.add_argument("--toolchain", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                        "..", "toolchains"),
                    help="bundled LLVM used to cross-compile shm_logger.c")
    args = ap.parse_args()
    root = tk.Tk()
    App(root, args)
    root.mainloop()


if __name__ == "__main__":
    main()
