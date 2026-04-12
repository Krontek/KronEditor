"""
position1.py — KronServer Motion Control GUI
=============================================
%MX0.0  BOOL  — Axis power enable
%MX0.1  BOOL  — Axis reset (MC_Reset)
%MX0.4  BOOL  — Axis stop
%MD1    REAL  — Position setpoint command (-10.000 .. 10.000)
%MD2    REAL  — Position feedback
%MD3    REAL  — Velocity setpoint command (-20.000 .. 20.000)
%MD4    REAL  — Velocity feedback
%MX0.2  BOOL  — Position trigger
%MX0.3  BOOL  — Velocity trigger
%MX0.5  BOOL  — HALT

Kullanım: python3 position1.py
"""

import json
import threading
import tkinter as tk
from tkinter import messagebox
import urllib.request

# ── Renkler ───────────────────────────────────────────────────────────────────
BG       = "#1e1e1e"
BG2      = "#252526"
BG3      = "#2d2d2d"
BORDER   = "#3a3a3a"
ACCENT   = "#007acc"
VEL_ACCENT = "#e65100"
GREEN    = "#00e676"
RED      = "#ef5350"
YELLOW   = "#ffb300"
TEXT     = "#cccccc"
TEXT_DIM = "#666666"
TEXT_H   = "#9cdcfe"

POWER_ADDR = "%MX0.0"
RESET_ADDR = "%MX0.1"
STOP_ADDR = "%MX0.4"
POSITION_ADDR = "%MD1"
POSITION_FEEDBACK_ADDR = "%MD2"
VELOCITY_ADDR = "%MD3"
VELOCITY_FEEDBACK_ADDR = "%MD4"
POSITION_TRIGGER_ADDR = "%MX0.2"
VELOCITY_TRIGGER_ADDR = "%MX0.3"
HALT_ADDR = "%MX0.5"

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
        self.title("Motion Control — KronServer")
        self.configure(bg=BG)
        self.resizable(False, False)

        self.client     = KronClient()
        self._names     = {}   # address.upper() → varname
        self._streaming = False
        self._power_on  = False
        self._reset_on  = False
        self._stop_on   = False
        self._halt_on   = False
        self._position_trigger_on = False
        self._velocity_trigger_on = False

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
        self.ent_host = ent(conn, 15); self.ent_host.insert(0, "192.168.1.121")
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
        main = tk.Frame(self, bg=BG, padx=24, pady=20)
        main.pack()

        tk.Label(main, text="MOTION CONTROL", bg=BG, fg=TEXT_H,
             font=("Consolas", 14, "bold")).pack(pady=(0, 14))

        admin = tk.Frame(main, bg=BG2, padx=18, pady=14)
        admin.pack(fill=tk.X, pady=(0, 18))

        tk.Label(admin, text="Administration", bg=BG2, fg=TEXT_H,
             font=("Consolas", 11, "bold")).pack(pady=(0, 10))

        admin_buttons = tk.Frame(admin, bg=BG2)
        admin_buttons.pack()

        power_wrap = tk.Frame(admin_buttons, bg=BG2)
        power_wrap.pack(side=tk.LEFT, padx=6)
        self.btn_power = tk.Button(power_wrap, text="POWER OFF", width=14,
                bg="#3a0000", fg=RED,
                relief=tk.FLAT, font=("Consolas", 11, "bold"),
                pady=6, cursor="hand2", state=tk.DISABLED,
                command=self._toggle_power)
        self.btn_power.pack()
        tk.Label(power_wrap, text="(%MX0.0)", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 7)).pack()

        reset_wrap = tk.Frame(admin_buttons, bg=BG2)
        reset_wrap.pack(side=tk.LEFT, padx=6)
        self.btn_reset = tk.Button(reset_wrap, text="RESET OFF", width=14,
                bg="#3a3a00", fg=YELLOW,
                relief=tk.FLAT, font=("Consolas", 11, "bold"),
                pady=6, cursor="hand2", state=tk.DISABLED,
                command=self._toggle_reset)
        self.btn_reset.pack()
        tk.Label(reset_wrap, text="(%MX0.1)", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 7)).pack()

        stop_wrap = tk.Frame(admin_buttons, bg=BG2)
        stop_wrap.pack(side=tk.LEFT, padx=6)
        self.btn_stop = tk.Button(stop_wrap, text="STOP OFF", width=14,
                   bg="#4a1212", fg=RED,
                   relief=tk.FLAT, font=("Consolas", 11, "bold"),
                   pady=6, cursor="hand2", state=tk.DISABLED,
                   command=self._toggle_stop)
        self.btn_stop.pack()
        tk.Label(stop_wrap, text="(%MX0.4)", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 7)).pack()

        halt_wrap = tk.Frame(admin_buttons, bg=BG2)
        halt_wrap.pack(side=tk.LEFT, padx=6)
        self.btn_halt = tk.Button(halt_wrap, text="HALT OFF", width=14,
                   bg="#3f1f4a", fg=TEXT_H,
                   relief=tk.FLAT, font=("Consolas", 11, "bold"),
                   pady=6, cursor="hand2", state=tk.DISABLED,
                   command=self._noop)
        self.btn_halt.pack()
        tk.Label(halt_wrap, text="(%MX0.5)", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 7)).pack()
        self._bind_momentary_button(self.btn_halt, HALT_ADDR, self._set_halt_ui)

        # ── Main motion area ──────────────────────────────────────────────────
        split = tk.Frame(main, bg=BG)
        split.pack()

        left = tk.Frame(split, bg=BG)
        left.pack(side=tk.LEFT, padx=(0, 18), anchor="n")

        right = tk.Frame(split, bg=BG)
        right.pack(side=tk.LEFT, anchor="n")

        # Position panel
        tk.Label(left, text="POSITION", bg=BG, fg=TEXT_H,
                 font=("Consolas", 13, "bold")).pack(pady=(0, 10))

        position_card = tk.Frame(left, bg=BG)
        position_card.pack()

        pos_head = tk.Frame(position_card, bg=BG)
        pos_head.pack()
        tk.Label(pos_head, text="Position Setpoint", bg=BG, fg=TEXT_DIM,
             font=("Consolas", 10)).pack(side=tk.LEFT)
        tk.Label(pos_head, text="(%MD1)", bg=BG, fg=TEXT_DIM,
             font=("Consolas", 7)).pack(side=tk.LEFT, padx=(4, 0), pady=(3, 0))

        self.lbl_position = tk.Label(position_card, text="0.000", bg=BG, fg=ACCENT,
                                     font=("Consolas", 22, "bold"))
        self.lbl_position.pack(pady=2)

        position_tick_row = tk.Frame(position_card, bg=BG)
        position_tick_row.pack()
        tk.Label(position_tick_row, text="-10", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.LEFT)
        self.position_slider = tk.Scale(position_card, from_=-10, to=10, orient=tk.HORIZONTAL,
                                        resolution=0.001, length=360,
                                        bg=BG, fg=TEXT, troughcolor=BG3,
                                        highlightthickness=0, bd=0,
                                        activebackground=ACCENT, sliderrelief=tk.FLAT,
                                        showvalue=False, command=self._on_position_slider)
        self.position_slider.set(0)
        self.position_slider.pack()
        tk.Label(position_tick_row, text="+10", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.RIGHT)

        self._draw_ticks(position_card, -10, 10, 360, 5)

        self.btn_position_trigger = tk.Button(position_card, text="▶  POSITION TRIGGER  OFF",
                              bg="#1a2a3a", fg=TEXT_DIM,
                              relief=tk.FLAT, font=("Consolas", 11, "bold"),
                              pady=7, padx=20, cursor="hand2",
                              state=tk.DISABLED)
        self.btn_position_trigger.pack(pady=(10, 0))
        tk.Label(position_card, text="(%MX0.2)", bg=BG, fg=TEXT_DIM,
             font=("Consolas", 7)).pack(pady=(2, 0))
        self._bind_momentary_button(self.btn_position_trigger,
                        POSITION_TRIGGER_ADDR,
                        self._set_position_trigger_ui)

        fb = tk.Frame(left, bg=BG2, padx=20, pady=14)
        fb.pack(fill=tk.X, pady=(14, 0))

        fb_head = tk.Frame(fb, bg=BG2)
        fb_head.pack()
        tk.Label(fb_head, text="Position Feedback", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 10)).pack(side=tk.LEFT)
        tk.Label(fb_head, text="(%MD2)", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 7)).pack(side=tk.LEFT, padx=(4, 0), pady=(3, 0))
        self.lbl_feedback = tk.Label(fb, text="—", bg=BG2, fg=GREEN,
                                     font=("Consolas", 28, "bold"))
        self.lbl_feedback.pack()

        # Velocity panel
        tk.Label(right, text="VELOCITY", bg=BG, fg=TEXT_H,
                 font=("Consolas", 13, "bold")).pack(pady=(0, 10))

        velocity_card = tk.Frame(right, bg=BG)
        velocity_card.pack()

        vel_head = tk.Frame(velocity_card, bg=BG)
        vel_head.pack()
        tk.Label(vel_head, text="Velocity Setpoint", bg=BG, fg=TEXT_DIM,
             font=("Consolas", 10)).pack(side=tk.LEFT)
        tk.Label(vel_head, text="(%MD3)", bg=BG, fg=TEXT_DIM,
             font=("Consolas", 7)).pack(side=tk.LEFT, padx=(4, 0), pady=(3, 0))

        self.lbl_velocity = tk.Label(velocity_card, text="0.000", bg=BG, fg=VEL_ACCENT,
                                     font=("Consolas", 22, "bold"))
        self.lbl_velocity.pack(pady=2)

        velocity_tick_row = tk.Frame(velocity_card, bg=BG)
        velocity_tick_row.pack()
        tk.Label(velocity_tick_row, text="-20", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.LEFT)
        self.velocity_slider = tk.Scale(velocity_card, from_=-20, to=20, orient=tk.HORIZONTAL,
                                        resolution=0.001, length=360,
                                        bg=BG, fg=TEXT, troughcolor=BG3,
                                        highlightthickness=0, bd=0,
                                        activebackground=VEL_ACCENT, sliderrelief=tk.FLAT,
                                        showvalue=False, command=self._on_velocity_slider)
        self.velocity_slider.set(0)
        self.velocity_slider.pack()
        tk.Label(velocity_tick_row, text="+20", bg=BG, fg=TEXT_DIM,
                 font=("Consolas", 9)).pack(side=tk.RIGHT)

        self._draw_ticks(velocity_card, -20, 20, 360, 10)

        self.btn_velocity_trigger = tk.Button(right, text="▶  VELOCITY TRIGGER  OFF", 
                                              bg="#1a2a3a", fg=TEXT_DIM,
                                              relief=tk.FLAT, font=("Consolas", 11, "bold"),
                                              pady=7, padx=20, cursor="hand2",
                                              state=tk.DISABLED,
                              command=self._noop)
        self.btn_velocity_trigger.pack(pady=(10, 0))
        tk.Label(right, text="(%MX0.3)", bg=BG, fg=TEXT_DIM,
             font=("Consolas", 7)).pack(pady=(2, 0))

        self._bind_momentary_button(self.btn_velocity_trigger, VELOCITY_TRIGGER_ADDR, self._set_velocity_trigger_ui)

        velocity_feedback = tk.Frame(right, bg=BG2, padx=20, pady=14)
        velocity_feedback.pack(fill=tk.X, pady=(14, 0))

        vel_fb_head = tk.Frame(velocity_feedback, bg=BG2)
        vel_fb_head.pack()
        tk.Label(vel_fb_head, text="Velocity Feedback", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 10)).pack(side=tk.LEFT)
        tk.Label(vel_fb_head, text="(%MD4)", bg=BG2, fg=TEXT_DIM,
             font=("Consolas", 7)).pack(side=tk.LEFT, padx=(4, 0), pady=(3, 0))
        self.lbl_velocity_feedback = tk.Label(velocity_feedback, text="—", bg=BG2, fg=VEL_ACCENT,
                                              font=("Consolas", 28, "bold"))
        self.lbl_velocity_feedback.pack()

        # Error bar
        self.lbl_err = tk.Label(main, text="", bg=BG, fg=TEXT_DIM,
                                 font=("Consolas", 9))
        self.lbl_err.pack(pady=(8, 0))

    def _draw_ticks(self, parent, minimum, maximum, width, label_step):
        canvas = tk.Canvas(parent, bg=BG, height=14, width=width,
                           highlightthickness=0, bd=0)
        canvas.pack()
        for val in range(minimum, maximum + 1, 1):
            x = int((val - minimum) / (maximum - minimum) * width)
            h = 8 if val % label_step == 0 else 4
            canvas.create_line(x, 0, x, h, fill=BORDER)
            if val % label_step == 0:
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
            for addr in (
                POWER_ADDR,
                RESET_ADDR,
                STOP_ADDR,
                POSITION_ADDR,
                POSITION_FEEDBACK_ADDR,
                VELOCITY_ADDR,
                VELOCITY_FEEDBACK_ADDR,
                VELOCITY_TRIGGER_ADDR,
                HALT_ADDR,
            ):
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
        self.btn_stop.config(state=tk.NORMAL)
        self.btn_halt.config(state=tk.NORMAL)
        self.btn_position_trigger.config(state=tk.NORMAL)
        self.btn_velocity_trigger.config(state=tk.NORMAL)
        # Read current power state
        try:
            pwr = self.client.read(self._names[POWER_ADDR.upper()])
            self._set_power_ui(bool(pwr))
        except Exception:
            pass
        try:
            self._set_stop_ui(bool(self.client.read(self._names[STOP_ADDR.upper()])))
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

    # ── Position Slider ─────────────────────────────────────────────────────

    def _on_position_slider(self, val):
        self.lbl_position.config(text=f"{float(val):.3f}")
        name = self._names.get(POSITION_ADDR.upper())
        if name and self.client.connected:
            threading.Thread(target=self._do_write,
                             args=(name, float(val), None),
                             daemon=True).start()

    def _on_velocity_slider(self, val):
        self.lbl_velocity.config(text=f"{float(val):.3f}")
        name = self._names.get(VELOCITY_ADDR.upper())
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

    # ── Stop ────────────────────────────────────────────────────────────────

    def _toggle_stop(self):
        new_state = not self._stop_on
        name = self._names.get(STOP_ADDR.upper())
        if not name:
            return
        threading.Thread(target=self._do_write,
                         args=(name, new_state, lambda: self._set_stop_ui(new_state)),
                         daemon=True).start()

    def _set_stop_ui(self, on: bool):
        self._stop_on = on
        if on:
            self.btn_stop.config(text="STOP ON", bg="#7a1d1d", fg=GREEN)
        else:
            self.btn_stop.config(text="STOP OFF", bg="#4a1212", fg=RED)

    # ── HALT ────────────────────────────────────────────────────────────────

    def _set_halt_ui(self, on: bool):
        self._halt_on = on
        if on:
            self.btn_halt.config(text="HALT ON", bg="#5a2a6a", fg=GREEN)
        else:
            self.btn_halt.config(text="HALT OFF", bg="#3f1f4a", fg=TEXT_H)

    def _press_halt(self):
        self._set_momentary_state(HALT_ADDR, True, self._set_halt_ui)

    def _release_halt(self):
        self._set_momentary_state(HALT_ADDR, False, self._set_halt_ui)

    # ── Position Trigger ────────────────────────────────────────────────────

    def _press_position_trigger(self):
        self._set_momentary_state(POSITION_TRIGGER_ADDR, True, self._set_position_trigger_ui)

    def _release_position_trigger(self):
        self._set_momentary_state(POSITION_TRIGGER_ADDR, False, self._set_position_trigger_ui)

    def _set_position_trigger_ui(self, on: bool):
        self._position_trigger_on = on
        if on:
            self.btn_position_trigger.config(text="▶  POSITION TRIGGER  ON",
                                             bg="#003a1a", fg=GREEN)
        else:
            self.btn_position_trigger.config(text="▶  POSITION TRIGGER  OFF",
                                             bg="#1a2a3a", fg=TEXT_DIM)

    # ── Velocity Trigger ────────────────────────────────────────────────────

    def _press_velocity_trigger(self):
        self._set_momentary_state(VELOCITY_TRIGGER_ADDR, True, self._set_velocity_trigger_ui)

    def _release_velocity_trigger(self):
        self._set_momentary_state(VELOCITY_TRIGGER_ADDR, False, self._set_velocity_trigger_ui)

    def _set_velocity_trigger_ui(self, on: bool):
        self._velocity_trigger_on = on
        if on:
            self.btn_velocity_trigger.config(text="▶  VELOCITY TRIGGER  ON",
                                             bg="#003a1a", fg=GREEN)
        else:
            self.btn_velocity_trigger.config(text="▶  VELOCITY TRIGGER  OFF",
                                             bg="#1a2a3a", fg=TEXT_DIM)

    def _bind_momentary_button(self, button, press_handler, release_handler):
        button.bind("<ButtonPress-1>", press_handler)
        button.bind("<ButtonRelease-1>", release_handler)
        button.bind("<Leave>", release_handler)

    def _momentary_state_async(self, address, value, ui_setter):
        name = self._names.get(address.upper())
        if not name:
            return
        threading.Thread(target=self._do_write,
                         args=(name, value, lambda: ui_setter(value)),
                         daemon=True).start()

    def _noop(self):
        pass

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
        except Exception:
            if self._streaming:
                self.after(0, self.lbl_conn.config,
                           {"text": "● Stream lost", "fg": YELLOW})

    def _on_live(self, flat: dict):
        fb_name = self._names.get(POSITION_FEEDBACK_ADDR.upper())
        if fb_name and fb_name in flat:
            val = flat[fb_name]
            try:
                self.lbl_feedback.config(text=f"{float(val):.3f}")
            except Exception:
                self.lbl_feedback.config(text=str(val))

        velocity_fb_name = self._names.get(VELOCITY_FEEDBACK_ADDR.upper())
        if velocity_fb_name and velocity_fb_name in flat:
            val = flat[velocity_fb_name]
            try:
                self.lbl_velocity_feedback.config(text=f"{float(val):.3f}")
            except Exception:
                self.lbl_velocity_feedback.config(text=str(val))

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
