#!/usr/bin/env python3
"""
advisor_control.py — tkinter remote control for the "advisor" boat project
(PLC_Projects/advisor_raspi3bplus.xml): two sliders, -100..+100, for

    %MD52  ext_drive_cmd   thrust %, sign = direction
    %MD56  ext_rudder_cmd  -100..+100 -> -90..+90 deg

The PLC only takes these while the RC transmitter's Switch B (rc_swb, %MX20.2)
is ON — otherwise the sticks drive. The status panel shows that switch, the
link watchdog and the drive outputs so it is obvious why a slider "does
nothing".

Variables are resolved BY ADDRESS, not by name, so a renamed variable keeps
working as long as its address stays. Every REST write is a FORCE: the value
stays pinned until "Release forces" (which releases every force on the PLC).

Usage:
    python3 advisor_control.py --host 192.168.1.104 --password krontek
Keys: Space = both to zero, Left/Right = rudder, Up/Down = drive (5 % steps).
"""
import argparse
import queue
import threading
import time
import tkinter as tk
import urllib.error
from tkinter import ttk

from kron_client import KronClient, add_common_args

DRIVE_ADDR = "%MD52"
RUDDER_ADDR = "%MD56"
# Shown read-only in the status panel: address -> label.
MONITOR = [
    ("%MX20.2", "Switch B (external cmd)"),
    ("%MX20.0", "RC link OK"),
    ("%MX20.1", "Switch A (enable)"),
    ("%MX26.2", "Drive armed"),
    ("%MX26.3", "Driver fault"),
    ("%MD22", "Thrust duty %"),
    ("%MX26.0", "Direction fwd"),
    ("%MD46", "Rudder angle deg"),
    ("%MD30", "Max duty %"),
]
SEND_PERIOD_S = 0.05     # at most 20 writes/s per slider
POLL_PERIOD_S = 0.2


class Worker(threading.Thread):
    """Owns the HTTP client; the Tk thread never blocks on the network.

    Slider writes are coalesced: only the LATEST pending value per variable is
    sent, so dragging fast never builds a backlog of stale commands.
    """

    def __init__(self, events):
        super().__init__(daemon=True)
        self.events = events              # -> Tk thread: (kind, payload)
        self.cmds = queue.Queue()         # <- Tk thread: (kind, payload)
        self.client = None
        self.by_addr = {}                 # address -> variable name
        self.pending = {}                 # address -> value to write
        self.lock = threading.Lock()

    def post(self, kind, payload=None):
        self.cmds.put((kind, payload))

    def set_value(self, addr, value):
        with self.lock:
            self.pending[addr] = value

    def run(self):
        last_poll = 0.0
        while True:
            try:
                kind, payload = self.cmds.get(timeout=SEND_PERIOD_S)
                self._dispatch(kind, payload)
                if kind == "quit":
                    return
            except queue.Empty:
                pass
            if not self.client:
                continue
            try:
                self._authed(self._flush)
                if time.monotonic() - last_poll >= POLL_PERIOD_S:
                    last_poll = time.monotonic()
                    values = self._authed(self.client.variables)
                    self.events.put(("values", {a: values.get(n)
                                                for a, n in self.by_addr.items()}))
            except Exception as e:  # noqa: BLE001 — surface anything to the UI
                # Giving up: leave the boat stopped, not at the last slider
                # value, and release the forces this client can no longer hold.
                self._zero_and_drop(release_forces=True)
                self.events.put(("error", f"connection lost: {e}"))

    def _authed(self, fn):
        """Run fn; on 401 re-authenticate ONCE and retry. Tokens expire (8 h)
        and are revoked when a deploy changes the API password, so a long
        session must not die on the first 401."""
        try:
            return fn()
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            self.client.auth()
            return fn()

    def _flush(self):
        with self.lock:
            pending, self.pending = self.pending, {}
        for addr, value in pending.items():
            name = self.by_addr.get(addr)
            if name:
                self.client.write(name, float(value))

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
                missing = [a for a in (DRIVE_ADDR, RUDDER_ADDR) if a not in by_addr]
                if missing:
                    raise RuntimeError("not on the PLC: " + ", ".join(missing)
                                       + " — wrong project deployed?")
                self.client, self.by_addr = c, by_addr
                rt = c.runtime()
                self.events.put(("connected", {
                    "base": c.base, "running": rt.get("running"),
                    "drive": by_addr[DRIVE_ADDR], "rudder": by_addr[RUDDER_ADDR]}))
            elif kind == "disconnect":
                self._zero_and_drop()
                self.events.put(("disconnected", None))
            elif kind == "clear":
                if self.client:
                    self.client.clear_forces()
                    self.events.put(("info", "all forces released — PLC owns the values again"))
            elif kind == "quit":
                self._zero_and_drop()
        except Exception as e:  # noqa: BLE001
            self.events.put(("error", str(e)))

    def _zero_and_drop(self, release_forces=False):
        """Leave the boat stopped and centred, never at the last slider value.

        Best effort, each step on its own: write both commands to 0 (with one
        re-auth on 401) and, when giving up on a broken connection, release
        the forces so nothing stays pinned by a client that is gone. A step
        that fails must not skip the next one. (A deliberate Disconnect keeps
        the zeros forced, as before — "Release forces" is the user's call.)"""
        if self.client:
            with self.lock:
                self.pending = {}
            for addr in (DRIVE_ADDR, RUDDER_ADDR):
                name = self.by_addr.get(addr)
                if not name:
                    continue
                try:
                    self._authed(lambda n=name: self.client.write(n, 0.0))
                except Exception:  # noqa: BLE001 — best effort on the way out
                    pass
            if release_forces:
                try:
                    self._authed(self.client.clear_forces)
                except Exception:  # noqa: BLE001
                    pass
        self.client = None


class App:
    def __init__(self, root, args):
        self.root = root
        self.events = queue.Queue()
        self.worker = Worker(self.events)
        self.worker.start()
        self.connected = False

        root.title("Advisor — drive / rudder")
        root.minsize(520, 0)
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

        # ── sliders ──
        ctl = ttk.LabelFrame(root, text="Commands (-100 … +100)")
        ctl.pack(fill="x", **pad)
        self.drive = tk.DoubleVar(value=0.0)
        self.rudder = tk.DoubleVar(value=0.0)
        self._slider(ctl, 0, "Drive  %MD52", self.drive, DRIVE_ADDR)
        self._slider(ctl, 1, "Rudder %MD56", self.rudder, RUDDER_ADDR)
        ctl.columnconfigure(1, weight=1)

        btns = ttk.Frame(root)
        btns.pack(fill="x", **pad)
        ttk.Button(btns, text="STOP / centre  (Space)", command=self.zero).pack(
            side="left", fill="x", expand=True)
        ttk.Button(btns, text="Release forces", command=lambda: self.worker.post("clear")).pack(
            side="left", padx=(8, 0))

        # ── status ──
        mon = ttk.LabelFrame(root, text="PLC status")
        mon.pack(fill="x", **pad)
        self.mon_vars = {}
        for i, (addr, label) in enumerate(MONITOR):
            r, c = divmod(i, 2)
            ttk.Label(mon, text=f"{label}").grid(row=r, column=c * 2, sticky="w", padx=(6, 4), pady=2)
            v = tk.StringVar(value="—")
            ttk.Label(mon, textvariable=v, width=10, anchor="e").grid(
                row=r, column=c * 2 + 1, sticky="e", padx=(0, 12))
            self.mon_vars[addr] = v
        self.hint = tk.StringVar(value="")
        ttk.Label(mon, textvariable=self.hint, foreground="#b45309").grid(
            row=len(MONITOR), column=0, columnspan=4, sticky="w", padx=6, pady=(4, 6))

        self.status = tk.StringVar(value="not connected")
        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w").pack(
            fill="x", side="bottom")

        root.bind("<space>", lambda e: self.zero())
        root.bind("<Up>", lambda e: self.nudge(self.drive, DRIVE_ADDR, +5))
        root.bind("<Down>", lambda e: self.nudge(self.drive, DRIVE_ADDR, -5))
        root.bind("<Right>", lambda e: self.nudge(self.rudder, RUDDER_ADDR, +5))
        root.bind("<Left>", lambda e: self.nudge(self.rudder, RUDDER_ADDR, -5))
        root.protocol("WM_DELETE_WINDOW", self.quit)
        root.after(50, self.pump)

    def _slider(self, parent, row, label, var, addr):
        ttk.Label(parent, text=label, font=("TkFixedFont", 10)).grid(
            row=row, column=0, sticky="w", padx=6)
        scale = tk.Scale(parent, from_=-100, to=100, resolution=1, orient="horizontal",
                         variable=var, showvalue=False, length=320,
                         command=lambda _v: self.send(addr, var))
        scale.grid(row=row, column=1, sticky="ew", padx=6, pady=6)
        out = ttk.Label(parent, width=7, anchor="e", font=("TkFixedFont", 11, "bold"))
        out.grid(row=row, column=2, padx=6)
        var.trace_add("write", lambda *_: out.config(text=f"{var.get():+.0f}"))
        out.config(text="+0")
        ttk.Button(parent, text="0", width=3,
                   command=lambda: (var.set(0), self.send(addr, var))).grid(row=row, column=3, padx=6)

    # ── actions ──
    def send(self, addr, var):
        if self.connected:
            self.worker.set_value(addr, var.get())

    def nudge(self, var, addr, step):
        if isinstance(self.root.focus_get(), (tk.Entry, ttk.Entry)):
            return
        var.set(max(-100, min(100, var.get() + step)))
        self.send(addr, var)

    def zero(self):
        if isinstance(self.root.focus_get(), (tk.Entry, ttk.Entry)):
            return
        for var, addr in ((self.drive, DRIVE_ADDR), (self.rudder, RUDDER_ADDR)):
            var.set(0)
            self.send(addr, var)

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

    def quit(self):
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
                run = "RUNNING" if p["running"] else "runtime STOPPED"
                self.status.set(f"connected {p['base']} — {run} — "
                                f"drive={p['drive']} rudder={p['rudder']}")
                # Start from a known state instead of whatever was forced last.
                self.zero()
            elif kind == "disconnected":
                self.connected = False
                self.btn_conn.config(text="Connect")
                self.status.set("disconnected (commands zeroed)")
                for v in self.mon_vars.values():
                    v.set("—")
            elif kind == "values":
                self.show(p)
            elif kind == "info":
                self.status.set(p)
            elif kind == "error":
                if p.startswith("connection lost"):
                    self.connected = False
                    self.btn_conn.config(text="Connect")
                self.status.set("error: " + p)
        self.root.after(50, self.pump)

    def show(self, values):
        for addr, var in self.mon_vars.items():
            v = values.get(addr)
            if v is None:
                var.set("n/a")
            elif isinstance(v, bool):
                var.set("ON" if v else "off")
            elif isinstance(v, float):
                var.set(f"{v:.1f}")
            else:
                var.set(str(v))
        if values.get("%MX20.2") is False:
            self.hint.set("Switch B is OFF — the PLC follows the RC sticks, not these sliders.")
        elif values.get("%MX20.0") is False:
            self.hint.set("RC link lost — the PLC holds drive/rudder safe regardless of commands.")
        elif values.get("%MX26.3"):
            self.hint.set("Driver fault reported.")
        elif values.get("%MX20.1") is False:
            self.hint.set("Switch A is OFF — drive disarmed, rudder released.")
        elif values.get("%MX26.2") is False:
            self.hint.set("Not armed — arming needs the drive command at neutral: press STOP.")
        else:
            self.hint.set("")


def main():
    ap = add_common_args(argparse.ArgumentParser(description=__doc__,
                                                 formatter_class=argparse.RawDescriptionHelpFormatter))
    args = ap.parse_args()
    root = tk.Tk()
    App(root, args)
    root.mainloop()


if __name__ == "__main__":
    main()
