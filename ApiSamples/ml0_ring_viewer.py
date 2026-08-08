#!/usr/bin/env python3
"""
ml0_ring_viewer.py — tkinter viewer for KronServer's LOSSLESS capture ring.

Reads N addressed variables starting at %ML0 over /api/v1/stream/ring (every
scan, no aliasing) and shows, per variable:
    • how many values it has read so far   (climbs at the scan rate → proof of
      lossless capture)
    • the current (instant) value           (a separate column)

The "number of variables" is what you enter in the "Variables from ML0" box —
it reads that many, in %ML address order (ML0, ML1, ...).

Run:  python3 ml0_ring_viewer.py
(then fill in host / password and Connect — defaults 192.168.0.23 / krontek)

Requires a runtime built with the capture ring (a normal Build & Send) and a
KronServer that serves /api/v1/stream/ring.
"""
import json
import struct
import threading
import time
import tkinter as tk
from tkinter import ttk
import urllib.request
import urllib.error

TYPE_FMT = {
    "bool": ("?", 1), "int8": ("b", 1), "uint8": ("B", 1),
    "int16": ("h", 2), "uint16": ("H", 2), "int32": ("i", 4), "uint32": ("I", 4),
    "int64": ("q", 8), "uint64": ("Q", 8), "float32": ("f", 4), "float64": ("d", 8),
}


def _read_exact(resp, n):
    chunks, got = [], 0
    while got < n:
        b = resp.read(n - got)
        if not b:
            return b""
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


class RingReader(threading.Thread):
    """Background thread: auth, fetch layout, stream and decode ring records.

    Updates self.state under self.lock; the GUI polls it. Never touches tkinter.
    """

    def __init__(self, host, port, password, want_n):
        super().__init__(daemon=True)
        self.base = f"http://{host}:{port}"
        self.password = password
        self.want_n = want_n
        self.lock = threading.Lock()
        self.stop_flag = threading.Event()
        self._resp = None
        self._wanted_tasks = set()
        # shared state
        self.error = None
        self.connected = False
        self.vars = []          # [{ml, name, fmt, size, task_id, poff, count, value}]
        self.total_records = 0
        self.dropped = 0
        self.attach_backlog = None  # ring history lapped before we connected (not a stream loss)
        self.stride_n = 1
        self.started_at = None

    # ---- HTTP helpers -------------------------------------------------------
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

    # ---- thread body --------------------------------------------------------
    def run(self):
        try:
            token = self._auth()
            info = self._ring_info(token)
            if not info.get("available"):
                self._fail("Capture ring not available on the device: "
                           + str(info.get("reason", "unknown"))
                           + "\n(Build & Send a runtime that has addressed variables.)")
                return

            layout = info.get("layout")
            # Flatten the ring's addressed vars in %ML (payload/offset) order and
            # take the first N. Each display var carries its within-task payload
            # offset so we can decode it from a record of its task.
            display = []
            ml = 0
            if layout:
                for task in layout.get("tasks", []):
                    tid = task["task_id"]
                    poff = 0
                    for v in task.get("vars", []):
                        fmt, sz = TYPE_FMT.get(v["type"], ("%ds" % v["size"], v["size"]))
                        display.append({
                            "ml": ml, "name": v["name"], "fmt": fmt, "size": sz,
                            "task_id": tid, "poff": poff, "count": 0, "value": None,
                        })
                        poff += sz
                        ml += 1
            if not display:
                self._fail("The device reports no addressed variables in the ring.")
                return
            if self.want_n > 0:
                display = display[: self.want_n]

            with self.lock:
                self.vars = display
                self.connected = True
                self.started_at = time.time()

            self._wanted_tasks = {d["task_id"] for d in display}

            # stream
            req = urllib.request.Request(self.base + "/api/v1/stream/ring",
                                         headers={"Authorization": "Bearer " + token})
            self._resp = urllib.request.urlopen(req, timeout=10)
            resp = self._resp

            while not self.stop_flag.is_set():
                head = _read_exact(resp, 4)
                if len(head) < 4:
                    break
                body = _read_exact(resp, struct.unpack("<I", head)[0])
                if not body:
                    break
                self._apply_frame(body)
            with self.lock:
                self.connected = False
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self._fail(
                    "404 — this device's KronServer does not have the capture-ring "
                    "endpoints (/api/v1/ring/info, /api/v1/stream/ring).\n"
                    "The KronServer (plc-agent) on the device is an OLD build. Build & "
                    "Send only updates the RUNTIME, not the agent — redeploy KronServer: "
                    "run server/build.sh, then Settings → Deploy Server to Target.")
            elif e.code == 401:
                self._fail("401 — wrong API password (Settings → Connection → API password).")
            else:
                self._fail(f"HTTP {e.code}: {e.reason}")
        except urllib.error.URLError as e:
            self._fail(f"Cannot reach {self.base}: {e.reason}")
        except Exception as e:  # noqa
            self._fail(str(e))

    def _apply_frame(self, body):
        """Decode one /stream/ring frame body (post length prefix) and fold it
        into the shared state: per-variable value + running count, plus totals.
        Returns the number of records that belonged to our tracked tasks."""
        count, stride_n, dropped = struct.unpack_from("<IIQ", body, 0)
        off = 16
        updates = {}  # ml -> (value, hits)
        recs_for_us = 0
        for _ in range(count):
            seq, task_id, plen = struct.unpack_from("<QHH", body, off)
            payload = body[off + 12: off + 12 + plen]
            off += 12 + plen
            if task_id not in self._wanted_tasks:
                continue
            recs_for_us += 1
            for d in self.vars:
                if d["task_id"] != task_id:
                    continue
                try:
                    val = struct.unpack_from("<" + d["fmt"], payload, d["poff"])[0]
                except struct.error:
                    continue
                prev = updates.get(d["ml"], (None, 0))
                updates[d["ml"]] = (val, prev[1] + 1)
        with self.lock:
            self.stride_n = stride_n
            self.dropped = dropped
            if self.attach_backlog is None:
                self.attach_backlog = dropped  # first frame = pre-connect history
            self.total_records += recs_for_us
            for d in self.vars:
                u = updates.get(d["ml"])
                if u is not None:
                    d["value"] = u[0]
                    d["count"] += u[1]
        return recs_for_us

    def _fail(self, msg):
        with self.lock:
            self.error = msg
            self.connected = False

    def stop(self):
        self.stop_flag.set()
        try:
            if self._resp is not None:
                self._resp.close()
        except Exception:
            pass


class App:
    def __init__(self, root):
        self.root = root
        self.reader = None
        root.title("KronServer — %ML Lossless Ring Viewer")
        root.geometry("760x480")

        top = ttk.Frame(root, padding=8)
        top.pack(fill="x")

        ttk.Label(top, text="Host:").grid(row=0, column=0, sticky="e")
        self.host = ttk.Entry(top, width=14)
        self.host.insert(0, "10.42.0.50")
        self.host.grid(row=0, column=1, padx=(2, 8))

        ttk.Label(top, text="Port:").grid(row=0, column=2, sticky="e")
        self.port = ttk.Entry(top, width=6)
        self.port.insert(0, "7070")
        self.port.grid(row=0, column=3, padx=(2, 8))

        ttk.Label(top, text="Password:").grid(row=0, column=4, sticky="e")
        self.pw = ttk.Entry(top, width=12, show="•")
        self.pw.insert(0, "krontek")
        self.pw.grid(row=0, column=5, padx=(2, 8))

        ttk.Label(top, text="Variables from ML0:").grid(row=1, column=0, columnspan=2, sticky="e", pady=(6, 0))
        self.nvar = ttk.Spinbox(top, from_=1, to=64, width=5)
        self.nvar.set(1)
        self.nvar.grid(row=1, column=2, sticky="w", pady=(6, 0))

        self.btn = ttk.Button(top, text="Connect", command=self.toggle)
        self.btn.grid(row=1, column=5, sticky="e", pady=(6, 0))

        # status line
        self.status = ttk.Label(root, text="Disconnected", foreground="#888", padding=(8, 2))
        self.status.pack(fill="x")

        # table
        cols = ("addr", "name", "count", "value")
        self.tree = ttk.Treeview(root, columns=cols, show="headings", height=14)
        self.tree.heading("addr", text="Address")
        self.tree.heading("name", text="Variable")
        self.tree.heading("count", text="Values read")
        self.tree.heading("value", text="Current value")
        self.tree.column("addr", width=90, anchor="center")
        self.tree.column("name", width=300, anchor="w")
        self.tree.column("count", width=140, anchor="e")
        self.tree.column("value", width=160, anchor="e")
        self.tree.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        self.rows = {}  # ml -> tree item id
        self.root.after(150, self.refresh)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def toggle(self):
        if self.reader and self.reader.is_alive():
            self.reader.stop()
            self.reader = None
            self.btn.config(text="Connect")
            self.status.config(text="Disconnecting…", foreground="#888")
            return
        try:
            n = int(self.nvar.get())
        except ValueError:
            n = 1
        for iid in self.tree.get_children():
            self.tree.delete(iid)
        self.rows.clear()
        self.reader = RingReader(self.host.get().strip(), self.port.get().strip(),
                                 self.pw.get(), n)
        self.reader.start()
        self.btn.config(text="Disconnect")
        self.status.config(text="Connecting…", foreground="#c80")

    def refresh(self):
        r = self.reader
        if r:
            with r.lock:
                err = r.error
                connected = r.connected
                total = r.total_records
                dropped = r.dropped
                backlog = r.attach_backlog or 0
                stride = r.stride_n
                started = r.started_at
                snapshot = [(d["ml"], d["name"], d["count"], d["value"]) for d in r.vars]
            if err:
                self.status.config(text="Error: " + err, foreground="#c00")
                self.btn.config(text="Connect")
                self.reader = None
            else:
                # (re)build rows if the set changed
                for ml, name, count, value in snapshot:
                    vtxt = "—" if value is None else (f"{value:.6g}" if isinstance(value, float) else str(value))
                    if ml not in self.rows:
                        self.rows[ml] = self.tree.insert(
                            "", "end", values=(f"%ML{ml}", name, count, vtxt))
                    else:
                        self.tree.item(self.rows[ml], values=(f"%ML{ml}", name, f"{count:,}", vtxt))
                rate = 0.0
                if started and total:
                    dt = time.time() - started
                    rate = total / dt if dt > 0 else 0
                state = "● Connected" if connected else "○ Idle"
                # only drops AFTER attach are a real streaming loss; the first
                # frame's dropped is ring history from before we connected.
                stream_drops = max(0, dropped - backlog)
                loss = "" if stream_drops == 0 else f"  ⚠ streaming drops={stream_drops:,}"
                self.status.config(
                    text=f"{state}   total read: {total:,}   rate: {rate:,.0f}/s   "
                         f"stride_N: {stride}{loss}",
                    foreground="#0a0" if connected else "#888")
        self.root.after(150, self.refresh)

    def on_close(self):
        if self.reader:
            self.reader.stop()
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
