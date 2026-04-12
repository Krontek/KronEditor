"""
position1.py — KronServer Position Control GUI
===============================================
%MX0.0  BOOL  — Axis power enable
%MX0.1  BOOL  — Axis reset (MC_Reset)
%MX0.2  BOOL  — Position trigger
%MD1    REAL  — Target position command (-10.000 .. 10.000)
%MD2    REAL  — Position feedback

Kullanım: python3 position1.py
"""

import json
import threading
import time
import tkinter as tk
from tkinter import messagebox
import urllib.request
import urllib.error

# ── Renkler ───────────────────────────────────────────────────────────────────
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

POWER_ADDR   = "%MX0.0"
RESET_ADDR   = "%MX0.1"
TRIGGER_ADDR = "%MX0.2"
TARGET_ADDR  = "%MD1"
FEEDBACK_ADDR= "%MD2"

# ── API Client (aynı kron_client mantığı) ─────────────────────────────────────

class KronClient:
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

    def get(self, path):   return self._request("GET",  path)
    def post(self, path, body=None): return self._request("POST", path, body)

    def connect(self, host, port, password):
        self.base_url = f"http://{host}:{port}"
        self.token    = ""
        if password:
            resp = self.post("/api/v1/auth", {"password": password})
            self.token = resp.get("token", "")
        self.connected = True

    def resolve(self, address):
        """address → variable name"""
        all_vals = self.get("/api/v1/variables")
        for name in all_vals:
            d = self.get(f"/api/v1/variables/{name}")
            if (d.get("address") or "").upper() == address.upper():
                return name
        raise KeyError(f"Address not found: {address}")

    def read(self, name):
        return self.get(f"/api/v1/variables/{name}")["value"]

    def write(self, name, value):
        self.post(f"/api/v1/variables/{name}", {"value": value})

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

# ── GUI ───────────────────────────────────────────────────────────────────────

class PositionApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Position Control — KronServer")
        self.configure(bg=BG)
        self.resizable(False, False)

        self.client     = KronClient()
        self._names     = {}   # address.upper() → varname
        self._streaming = False
        self._power_on  = False
        self._reset_on  = False
        self._move_on   = False

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── Build ─────────────────────────────────────────────────────────────────

    def _build_ui(self):
        # ── Connection bar ────────────────────────────────────────────────────
        conn = tk.Frame(self, bg=BG2, padx=10, pady=8)
        conn.pack(fill=tk.X)

        def lbl(parent, t):
            return tk.Label(parent, text=t, bg=BG2, fg=TEXT, font=("Consolas", 10))
        def ent(parent, w, show=None):
            kw = {"show": show} if show else {}
            return tk.Entry(parent, width=w, bg=BG3, fg=TEXT, insertbackground=TEXT,
                            relief=tk.FLAT, font=("Consolas", 10),
                            highlightthickness=1, highlightbackground=BORDER, **kw)

        lbl(conn, "Host:").pack(side=tk.LEFT)
        self.ent_host = ent(conn, 15); self.ent_host.insert(0, "10.42.0.71")
        self.ent_host.pack(side=tk.LEFT, padx=(3, 10))

        lbl(conn, "Port:").pack(side=tk.LEFT)
        self.ent_port = ent(conn, 6); self.ent_port.insert(0, "7070")
        self.ent_port.pack(side=tk.LEFT, padx=(3, 10))

        lbl(conn, "Password:").pack(side=tk.LEFT)
        self.ent_pass = ent(conn, 12, show="*"); self.ent_pass.insert(0, "krontek")
        self.ent_pass.pack(side=tk.LEFT, padx=(3, 10))
        self.ent_pass.bind("<Return>", lambda _: self._on_connect())

        self.btn_conn = tk.Button(conn, text="Connect", bg=ACCENT, fg="#fff",
                                   relief=tk.FLAT, font=("Consolas", 10, "bold"),
                                   padx=12, pady=2, cursor="hand2",
                                   command=self._on_connect)
        self.btn_conn.pack(side=tk.LEFT, padx=(0, 12))

        self.lbl_conn = tk.Label(conn, text="● Disconnected", bg=BG2,
                                  fg=RED, font=("Consolas", 10, "bold"))
        self.lbl_conn.pack(side=tk.LEFT)

        # ── Main panel ────────────────────────────────────────────────────────
        main = tk.Frame(self, bg=BG, padx=30, pady=20)
        main.pack()

        # Title
        tk.Label(main, text="POSITION CONTROL", bg=BG, fg=TEXT_H,
                 font=("Consolas", 14, "bold")).pack(pady=(0, 16))

        # Power button
        pf = tk.Frame(main, bg=BG)
        pf.pack(pady=(0, 20))
        tk.Label(pf, text="Axis Power", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 10)).pack()
        self.btn_power = tk.Button(pf, text="POWER OFF", width=16,
                                    bg="#3a0000", fg=RED,
                                    relief=tk.FLAT, font=("Consolas", 12, "bold"),
                                    pady=8, cursor="hand2", state=tk.DISABLED,
                                    command=self._toggle_power)
        self.btn_power.pack(pady=4)

        # Reset button
        rf = tk.Frame(main, bg=BG)
        rf.pack(pady=(0, 20))
        tk.Label(rf, text="Axis Reset (MC_Reset)", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 10)).pack()
        self.btn_reset = tk.Button(rf, text="RESET OFF", width=16,
                                    bg="#3a3a00", fg=YELLOW,
                                    relief=tk.FLAT, font=("Consolas", 12, "bold"),
                                    pady=8, cursor="hand2", state=tk.DISABLED,
                                    command=self._toggle_reset)
        self.btn_reset.pack(pady=4)

        # Slider — Target position
        sf = tk.Frame(main, bg=BG)
        sf.pack(pady=(0, 10))

        tk.Label(sf, text="Target Position  (-10.000 .. 10.000)  (%MD1)", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 10)).pack()

        self.lbl_target = tk.Label(sf, text="0.000", bg=BG, fg=ACCENT,
                                    font=("Consolas", 22, "bold"))
        self.lbl_target.pack(pady=2)

        tick_row = tk.Frame(sf, bg=BG)
        tick_row.pack()
        tk.Label(tick_row, text="-10", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.LEFT)
        self.slider = tk.Scale(sf, from_=-10, to=10, orient=tk.HORIZONTAL,
                                resolution=0.001, length=400,
                                bg=BG, fg=TEXT, troughcolor=BG3,
                                highlightthickness=0, bd=0,
                                activebackground=ACCENT, sliderrelief=tk.FLAT,
                                showvalue=False, command=self._on_slider)
        self.slider.set(0)
        self.slider.pack()
        tk.Label(tick_row, text="+10", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.RIGHT)

        # Tick marks
        self._draw_ticks(sf)

        # Position trigger button
        self.btn_trigger = tk.Button(main, text="▶  POSITION TRIGGER  (%MX0.2)",
                                      bg="#1a2a3a", fg=TEXT_DIM,
                                      relief=tk.FLAT, font=("Consolas", 11, "bold"),
                                      pady=7, padx=20, cursor="hand2",
                                      state=tk.DISABLED,
                                      command=self._pulse_move)
        self.btn_trigger.pack(pady=(4, 20))

        # Feedback
        fb = tk.Frame(main, bg=BG2, padx=20, pady=14, relief=tk.FLAT)
        fb.pack(fill=tk.X)

        tk.Label(fb, text="Position Feedback  (%MD2)", bg=BG2, fg=TEXT_DIM,
                 font=("Consolas", 10)).pack()
        self.lbl_feedback = tk.Label(fb, text="—", bg=BG2, fg=GREEN,
                                      font=("Consolas", 28, "bold"))
        self.lbl_feedback.pack()

        # Error bar
        self.lbl_err = tk.Label(main, text="", bg=BG, fg=TEXT_DIM,
                                 font=("Consolas", 9))
        self.lbl_err.pack(pady=(8, 0))

    def _draw_ticks(self, parent):
        canvas = tk.Canvas(parent, bg=BG, height=14, width=400,
                           highlightthickness=0, bd=0)
        canvas.pack()
        for val in range(-10, 11, 1):
            x = int((val + 10) / 20 * 400)
            h = 8 if val % 5 == 0 else 4
            canvas.create_line(x, 0, x, h, fill=BORDER)
            if val % 5 == 0:
                canvas.create_text(x, 13, text=str(val), fill=TEXT_DIM,
                                   font=("Consolas", 8), anchor="s")

    # ── Connect ───────────────────────────────────────────────────────────────

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
            # Resolve addresses
            for addr in (POWER_ADDR, RESET_ADDR, TRIGGER_ADDR, TARGET_ADDR, FEEDBACK_ADDR):
                name = self.client.resolve(addr)
                self._names[addr.upper()] = name
            self.after(0, self._on_connected)
        except Exception as e:
            self.after(0, self._on_connect_fail, str(e))

    def _on_connected(self):
        self.btn_conn.config(state=tk.NORMAL, text="Reconnect")
        self.lbl_conn.config(text="● Connected", fg=GREEN)
        self.btn_power.config(state=tk.NORMAL)
        self.btn_reset.config(state=tk.NORMAL)
        self.btn_trigger.config(state=tk.NORMAL)
        # Read current power state
        try:
            pwr = self.client.read(self._names[POWER_ADDR.upper()])
            self._set_power_ui(bool(pwr))
        except Exception:
            pass
        self._start_stream()
        self._log("Connected. Streaming live data.")

    def _on_connect_fail(self, err):
        self.btn_conn.config(state=tk.NORMAL, text="Connect")
        self.lbl_conn.config(text="● Error", fg=YELLOW)
        messagebox.showerror("Connection Failed", err)

    # ── Power ─────────────────────────────────────────────────────────────────

    def _toggle_power(self):
        new_state = not self._power_on
        name = self._names.get(POWER_ADDR.upper())
        if not name:
            return
        threading.Thread(target=self._do_write,
                         args=(name, new_state, lambda: self._set_power_ui(new_state)),
                         daemon=True).start()

    def _set_power_ui(self, on: bool):
        self._power_on = on
        if on:
            self.btn_power.config(text="POWER ON", bg="#003a00", fg=GREEN)
        else:
            self.btn_power.config(text="POWER OFF", bg="#3a0000", fg=RED)

    # ── Slider ────────────────────────────────────────────────────────────────

    def _on_slider(self, val):
        self.lbl_target.config(text=f"{float(val):.3f}")
        name = self._names.get(TARGET_ADDR.upper())
        if name and self.client.connected:
            threading.Thread(target=self._do_write,
                             args=(name, float(val), None),
                             daemon=True).start()

    # ── Reset (MC_Reset) ────────────────────────────────────────────────────

    def _toggle_reset(self):
        new_state = not self._reset_on
        name = self._names.get(RESET_ADDR.upper())
        if not name:
            return
        threading.Thread(target=self._do_write,
                         args=(name, new_state, lambda: self._set_reset_ui(new_state)),
                         daemon=True).start()

    def _set_reset_ui(self, on: bool):
        self._reset_on = on
        if on:
            self.btn_reset.config(text="RESET ON", bg="#3a3a00", fg=GREEN)
        else:
            self.btn_reset.config(text="RESET OFF", bg="#3a3a00", fg=YELLOW)

    # ── Position trigger ──────────────────────────────────────────────────────

    def _pulse_move(self):
        name = self._names.get(TRIGGER_ADDR.upper())
        if not name:
            return
        threading.Thread(target=self._do_pulse_move, args=(name,), daemon=True).start()

    def _do_pulse_move(self, name):
        try:
            self.client.write(name, True)
            self.after(0, self._set_move_ui, True)
            time.sleep(0.12)
            self.client.write(name, False)
            self.after(0, self._set_move_ui, False)
        except Exception as e:
            self.after(0, self._log, f"Write error: {e}")

    def _set_move_ui(self, on: bool):
        self._move_on = on
        if on:
            self.btn_trigger.config(text="▶  POSITION TRIGGER  ACTIVE  (%MX0.2)",
                                    bg="#003a1a", fg=GREEN)
        else:
            self.btn_trigger.config(text="▶  POSITION TRIGGER  (%MX0.2)",
                                    bg="#1a2a3a", fg=TEXT_DIM)

    # ── Stream ────────────────────────────────────────────────────────────────

    def _start_stream(self):
        self._streaming = True
        threading.Thread(target=self._stream_worker, daemon=True).start()

    def _stream_worker(self):
        try:
            for flat in self.client.stream_iter():
                if not self._streaming:
                    break
                self.after(0, self._on_live, flat)
        except Exception as e:
            if self._streaming:
                self.after(0, self.lbl_conn.config,
                           {"text": "● Stream lost", "fg": YELLOW})

    def _on_live(self, flat: dict):
        fb_name = self._names.get(FEEDBACK_ADDR.upper())
        if fb_name and fb_name in flat:
            val = flat[fb_name]
            try:
                self.lbl_feedback.config(text=f"{float(val):.3f}")
            except Exception:
                self.lbl_feedback.config(text=str(val))

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _do_write(self, name, value, callback):
        try:
            self.client.write(name, value)
            if callback:
                self.after(0, callback)
        except Exception as e:
            self.after(0, self._log, f"Write error: {e}")

    def _log(self, msg):
        self.lbl_err.config(text=msg)

    def _on_close(self):
        self._streaming = False
        self.destroy()


if __name__ == "__main__":
    PositionApp().mainloop()
