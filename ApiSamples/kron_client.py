#!/usr/bin/env python3
"""
kron_client.py — minimal KronServer REST/stream client (stdlib only).

Shared by the numbered samples in this folder. Nothing here is project
specific: it talks to whatever addressed variables the deployed
variable_table.json happens to expose.

    from kron_client import KronClient

    c = KronClient("192.168.1.104", 7070, "krontek")
    c.auth()
    print(c.variables())              # {name: value} for every addressed var
    c.write("prog_Program0_speed", 12.5)
    for snap in c.stream_snapshots(): # SSE, one dict per tick
        print(snap)

Endpoints used (server/API.md is the full reference):
    POST /api/v1/auth                -> bearer token (8 h)
    GET  /api/v1/variables[/{name}]  -> read
    POST /api/v1/variables/{name}    -> force-write
    POST /api/v1/forces/clear        -> release all forces
    GET|POST /api/v1/runtime[...]    -> status / start / stop / config
    GET  /api/v1/stream              -> SSE snapshots (latest value per tick)
    GET  /api/v1/ring/info           -> capture-ring header + payload layout
    GET  /api/v1/stream/ring         -> binary lossless capture stream
"""
import json
import struct
import urllib.error
import urllib.request

# Ring/variable-table type -> (struct format, byte size). Little-endian throughout.
TYPE_FMT = {
    "bool": ("?", 1), "int8": ("b", 1), "uint8": ("B", 1),
    "int16": ("h", 2), "uint16": ("H", 2),
    "int32": ("i", 4), "uint32": ("I", 4),
    "int64": ("q", 8), "uint64": ("Q", 8),
    "float32": ("f", 4), "float64": ("d", 8),
}


class KronClient:
    def __init__(self, host="192.168.1.104", port=7070, password="krontek", timeout=5):
        self.base = f"http://{host}:{int(port)}"
        self.password = password
        self.timeout = timeout
        self.token = None

    # ── plumbing ─────────────────────────────────────────────────────────────
    def _request(self, method, path, body=None, stream=False, timeout=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=data,
                                     headers=headers, method=method)
        resp = urllib.request.urlopen(req, timeout=timeout or self.timeout)
        if stream:
            return resp                      # caller owns/closes the response
        with resp:
            raw = resp.read()
        return json.loads(raw) if raw else {}

    def auth(self):
        """Exchange the API password for a bearer token. Call this first."""
        self.token = None
        self.token = self._request("POST", "/api/v1/auth",
                                   {"password": self.password})["token"]
        return self.token

    # ── variables ────────────────────────────────────────────────────────────
    def variables(self):
        """All addressed variables as {name: value}."""
        return self._request("GET", "/api/v1/variables")

    def variable(self, name):
        """One variable with metadata: {name, value, type, address}."""
        return self._request("GET", f"/api/v1/variables/{name}")

    def write(self, name, value):
        """Force-write a value. It is pinned until clear_forces()."""
        return self._request("POST", f"/api/v1/variables/{name}", {"value": value})

    def clear_forces(self):
        return self._request("POST", "/api/v1/forces/clear")

    # ── runtime ──────────────────────────────────────────────────────────────
    def runtime(self):
        """{running, pid, auto_run, stream_interval_ms}."""
        return self._request("GET", "/api/v1/runtime")

    def start(self):
        return self._request("POST", "/api/v1/runtime/start", timeout=15)

    def stop(self):
        return self._request("POST", "/api/v1/runtime/stop", timeout=15)

    def config(self, **fields):
        """Partial update: auto_run, stream_interval_ms, ring_ram_percent."""
        return self._request("POST", "/api/v1/runtime/config", fields)

    # ── SSE snapshots ────────────────────────────────────────────────────────
    def stream_snapshots(self, timeout=None):
        """Yield one {name: value} dict per SSE tick until the caller stops.

        This is a SNAPSHOT feed: each tick reports whatever is in shared memory
        at that instant, so anything changing faster than stream_interval_ms is
        aliased away. Use the capture ring when every scan matters.
        """
        resp = self._request("GET", "/api/v1/stream", stream=True,
                             timeout=timeout or 60)
        try:
            for line in resp:
                if line.startswith(b"data: "):
                    yield json.loads(line[6:])
        finally:
            resp.close()

    # ── capture ring ─────────────────────────────────────────────────────────
    def ring_info(self):
        """Ring header + payload layout, or {'available': False, 'reason': ...}."""
        return self._request("GET", "/api/v1/ring/info")

    def stream_ring(self, layout, timeout=None):
        """Yield (seq, task_id, {name: value}) for every captured scan.

        `layout` is ring_info()["layout"]. Frames also carry decimation and
        loss counters — read them from ring_stats() after each yield if you
        need them, or use stream_ring_frames() for the raw per-frame view.
        """
        for frame in self.stream_ring_frames(layout, timeout=timeout):
            for rec in frame["records"]:
                yield rec

    def stream_ring_frames(self, layout, timeout=None):
        """Yield one decoded frame per 5 ms server tick:

            {"stride_n": N,          # 1 = every scan, N = every Nth (decimated)
             "dropped_total": D,     # cumulative ring-overwrite loss
             "records": [(seq, task_id, {name: value}), ...]}

        The FIRST frame's dropped_total is attach backlog, not streaming loss.
        """
        decoders = ring_decoders(layout)
        resp = self._request("GET", "/api/v1/stream/ring", stream=True,
                             timeout=timeout or 60)
        try:
            while True:
                head = _read_exact(resp, 4)
                if len(head) < 4:
                    return
                body = _read_exact(resp, struct.unpack("<I", head)[0])
                if not body:
                    return
                yield decode_ring_frame(body, decoders)
        finally:
            resp.close()


# ── ring decoding (pure functions, unit-testable without a device) ───────────
def ring_decoders(layout):
    """layout -> {task_id: [(name, struct_fmt, size), ...]} in payload order."""
    out = {}
    for task in layout.get("tasks", []):
        fields = []
        for var in task.get("vars", []):
            fmt, size = TYPE_FMT.get(var["type"], (None, var.get("size", 0)))
            fields.append((var["name"], fmt, var.get("size", size)))
        out[task["task_id"]] = fields
    return out


def decode_ring_frame(body, decoders):
    """Decode one frame body (everything after the u32 frame_len prefix)."""
    count, stride_n, dropped = struct.unpack_from("<IIQ", body, 0)
    off, records = 16, []
    for _ in range(count):
        seq, task_id, plen = struct.unpack_from("<QHH", body, off)
        payload = body[off + 12: off + 12 + plen]
        off += 12 + plen
        values, p = {}, 0
        for name, fmt, size in decoders.get(task_id, []):
            if fmt and p + size <= len(payload):
                values[name] = struct.unpack_from("<" + fmt, payload, p)[0]
            p += size
        records.append((seq, task_id, values))
    return {"stride_n": stride_n, "dropped_total": dropped, "records": records}


def _read_exact(resp, n):
    chunks, got = [], 0
    while got < n:
        b = resp.read(n - got)
        if not b:
            break
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def add_common_args(parser):
    """--host / --port / --password, shared by every sample in this folder."""
    parser.add_argument("--host", default="192.168.1.104")
    parser.add_argument("--port", type=int, default=7070)
    parser.add_argument("--password", default="krontek")
    return parser


def connect(args):
    c = KronClient(args.host, args.port, args.password)
    c.auth()
    return c
