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
    POST /api/v1/variables/{name}    -> write (force / pulse / unforce), acked
    POST /api/v1/forces/clear        -> release all forces
    GET|POST /api/v1/runtime[...]    -> status / start / stop / config
    GET  /api/v1/stream              -> SSE snapshots (latest value per tick)
    GET  /api/v1/ring/info           -> capture-ring header + payload layout
    GET  /api/v1/stream/ring?v=2     -> binary lossless capture stream (frame v2)
    GET  /api/v1/stream/buffered?v=2 -> binary sampled stream (frame v2)
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
        return parse_json_body(raw, method + " " + path)

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

    def write(self, name, value, mode="force"):
        """Write a value; returns once the PLC runtime has APPLIED it.

        mode: "force" (default — pinned until released), "pulse" (written once,
        the program owns it from the same scan) or "unforce" (release the pin;
        a non-None value is also written once). Errors: 409 runtime not running
        or runtime/server version mismatch, 503 command mailbox full, 504 the
        runtime did not acknowledge in time (nothing was applied).
        A 64-bit integer beyond +-2**53 is sent as a decimal string, exactly.
        """
        body = {"value": value}
        if mode != "force":
            body["mode"] = mode
        return self._request("POST", f"/api/v1/variables/{name}", body)

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
        """Yield (seq, task_id, {name: value}, scan) for every captured scan.

        `layout` is ring_info()["layout"]. Frames also carry decimation and
        loss counters — read them from ring_stats() after each yield if you
        need them, or use stream_ring_frames() for the raw per-frame view.
        """
        for frame in self.stream_ring_frames(layout, timeout=timeout):
            for rec in frame["records"]:
                yield rec

    def stream_ring_frames(self, layout, timeout=None):
        """Yield one decoded frame (wire format v2) per 5 ms server tick:

            {"version": 2,
             "stride_n": N,          # 1 = every scan, N = every Nth (decimated)
             "dropped_total": D,     # records lost since THIS connection opened
             "epoch": E,             # runtime generation
             "epoch_changed": bool,  # True on the first frame of a new epoch
             "layout": {...},        # the layout used to decode this frame
             "records": [(seq, task_id, {name: value}, scan), ...]}

        `scan` is the producer's per-task scan counter (low 32 bits):
        consecutive records of one task differ by stride_n.

        dropped_total starts at 0 for every connection (the server resumes at
        the producer's current position — there is no attach backlog), so it is
        ALL loss. Do not subtract the first frame's value: that hid real loss.

        On an epoch change (Build & Send / runtime restart) the payload layout
        may differ, so /api/v1/ring/info is re-fetched and the decoders rebuilt
        before the frame is decoded.
        """
        resp = self._request("GET", "/api/v1/stream/ring?v=2", stream=True,
                             timeout=timeout or 60)
        state = {"layout": layout, "decoders": ring_decoders(layout), "epoch": None}

        def relayout():
            info = self.ring_info()
            state["layout"] = info.get("layout") or {}
            state["decoders"] = ring_decoders(state["layout"])
            return state["decoders"]

        try:
            for body in read_ring_bodies(resp):
                hdr = ring_frame_header(body)
                changed = state["epoch"] is not None and hdr["epoch"] != state["epoch"]
                state["epoch"] = hdr["epoch"]
                decoders = relayout() if changed else state["decoders"]
                frame = decode_ring_frame(body, decoders)
                frame["epoch_changed"] = changed
                frame["layout"] = state["layout"]
                yield frame
        finally:
            resp.close()


    # ── buffered (server-sampled) stream ─────────────────────────────────────
    def stream_buffered(self, names, interval_us=1000, timeout=None):
        """Yield decoded /api/v1/stream/buffered?v=2 frames (see
        decode_buffered_frame). The server ENDS the stream when the variable
        table changes (Build & Send); reconnect to resolve offsets again."""
        info = {n: self.variable(n)["type"] for n in names}
        q = f"/api/v1/stream/buffered?v=2&interval_us={int(interval_us)}&vars=" + ",".join(names)
        resp = self._request("GET", q, stream=True, timeout=timeout or 60)
        try:
            for body in read_ring_bodies(resp):   # same u32-length framing
                yield decode_buffered_frame(body, names, [info[n] for n in names])
        finally:
            resp.close()


# ── IEC TIME / LTIME ─────────────────────────────────────────────────────────
# A TIME or LTIME variable is published with type "int64": a SIGNED count of
# microseconds (T#2h = 7200000000, T#-5s = -5000000). The ring and buffered
# decoders already read it as "<q". Over REST/SSE a value beyond +/-2^53 is a
# decimal STRING (so JSON clients keep it exact) — time_us() accepts both.
def time_us(value):
    """REST/SSE/ring value of a TIME variable -> int microseconds."""
    return int(value)


def format_iec_time(value):
    """Microseconds (int or decimal string) -> IEC literal, e.g. 'T#1h30m', 'T#-5s'."""
    us = time_us(value)
    if us == 0:
        return "T#0s"
    sign, rem = ("-", -us) if us < 0 else ("", us)
    out = "T#" + sign
    for unit, suffix in ((86_400_000_000, "d"), (3_600_000_000, "h"), (60_000_000, "m"),
                         (1_000_000, "s"), (1_000, "ms"), (1, "us")):
        q, rem = divmod(rem, unit)
        if q:
            out += f"{q}{suffix}"
    return out


class KronProtocolError(RuntimeError):
    """The server answered with something this client cannot trust."""


def parse_json_body(raw, what="response"):
    """Decode a JSON response body. An EMPTY body is an error, not {}: every
    KronServer JSON endpoint writes a body, and an older server answered a
    failed encode with "200 + nothing" — treating that as "no variables" hid a
    broken stream behind an empty dict."""
    if not raw or not raw.strip():
        raise KronProtocolError(f"{what}: empty response body where JSON was expected")
    return json.loads(raw)


def read_ring_bodies(resp):
    """Yield raw frame bodies (after the u32 frame_len) from a stream. A clean
    end between frames just stops; a frame cut short raises, so a truncated
    stream is never mistaken for a short frame."""
    while True:
        head = _read_exact(resp, 4)
        if not head:
            return
        if len(head) < 4:
            raise KronProtocolError(f"ring stream ended inside a frame header ({len(head)}/4 bytes)")
        frame_len = struct.unpack("<I", head)[0]
        body = _read_exact(resp, frame_len)
        if len(body) != frame_len:
            raise KronProtocolError(
                f"ring frame truncated: got {len(body)} of {frame_len} bytes")
        yield body


def read_ring_frames(resp, decoders):
    """Yield decoded frames from a /api/v1/stream/ring?v=2 byte stream (any
    object with .read(n))."""
    for body in read_ring_bodies(resp):
        yield decode_ring_frame(body, decoders)


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


RING_FRAME_VERSION = 2
RING_RECORD_HEADER = struct.Struct("<QHHI")   # seq, task_id, payload_len, scan


def ring_frame_header(body):
    """Decode the v2 frame header (body = everything after u32 frame_len):

        u16 version, u16 header_len, u32 record_count, u32 stride_N,
        u64 dropped_total, u64 epoch

    Raises KronProtocolError on any other version — a v1 frame decoded with
    v2 offsets (or the reverse) yields plausible garbage, never an error.
    """
    if len(body) < 4:
        raise KronProtocolError(f"ring frame too short ({len(body)} bytes)")
    version, header_len = struct.unpack_from("<HH", body, 0)
    if version != RING_FRAME_VERSION:
        raise KronProtocolError(
            f"ring frame version {version}, this client speaks {RING_FRAME_VERSION} "
            "(update ApiSamples or the KronServer: server/build.sh + Deploy Server)")
    if header_len < 28 or header_len > len(body):
        raise KronProtocolError(f"ring frame header_len {header_len} invalid")
    count, stride_n, dropped, epoch = struct.unpack_from("<IIQQ", body, 4)
    return {"version": version, "header_len": header_len, "count": count,
            "stride_n": stride_n, "dropped_total": dropped, "epoch": epoch}


def iter_ring_records(body, hdr=None):
    """Yield (seq, task_id, scan, payload_offset, payload_len) per record,
    without copying payloads (for high-rate consumers)."""
    hdr = hdr or ring_frame_header(body)
    off = hdr["header_len"]
    for _ in range(hdr["count"]):
        seq, task_id, plen, scan = RING_RECORD_HEADER.unpack_from(body, off)
        start = off + RING_RECORD_HEADER.size
        if start + plen > len(body):
            raise KronProtocolError("ring record runs past the end of its frame")
        yield seq, task_id, scan, start, plen
        off = start + plen


def decode_ring_frame(body, decoders):
    """Decode one v2 frame body (everything after the u32 frame_len prefix)."""
    hdr = ring_frame_header(body)
    records = []
    for seq, task_id, scan, start, plen in iter_ring_records(body, hdr):
        payload = body[start:start + plen]
        values, p = {}, 0
        for name, fmt, size in decoders.get(task_id, []):
            if fmt and p + size <= len(payload):
                values[name] = struct.unpack_from("<" + fmt, payload, p)[0]
            p += size
        records.append((seq, task_id, values, scan))
    return {"version": hdr["version"], "stride_n": hdr["stride_n"],
            "dropped_total": hdr["dropped_total"], "epoch": hdr["epoch"],
            "records": records}


BUFFERED_FRAME_VERSION = 2
BUFFERED_TYPE_CODES = ["bool", "int8", "uint8", "int16", "uint16", "int32",
                       "uint32", "int64", "uint64", "float32", "float64"]


def decode_buffered_frame(body, names=None, types=None):
    """Decode one /api/v1/stream/buffered v2 frame body:

        u16 version, u16 var_count, u32 sample_count, u32 interval_us,
        u32 missed, u64 t_first_us, u8 types[var_count], samples...

    Returns {"t_first_us", "interval_us", "missed", "samples": [[v0, v1, ...]]}.
    Sample i was taken at about t_first_us + i*interval_us; missed > 0 means
    that many grid points went unsampled somewhere in (or before) this frame.
    """
    if len(body) < 24:
        raise KronProtocolError(f"buffered frame too short ({len(body)} bytes)")
    version, nvars, count, interval_us, missed, t_first = struct.unpack_from("<HHIIIQ", body, 0)
    if version != BUFFERED_FRAME_VERSION:
        raise KronProtocolError(f"buffered frame version {version}, expected {BUFFERED_FRAME_VERSION}")
    codes = body[24:24 + nvars]
    fmts = []
    for c in codes:
        if c >= len(BUFFERED_TYPE_CODES):
            raise KronProtocolError(f"unknown buffered type code {c}")
        fmts.append(TYPE_FMT[BUFFERED_TYPE_CODES[c]][0])
    rec = struct.Struct("<" + "".join(fmts))
    off = 24 + nvars
    if off + count * rec.size != len(body):
        raise KronProtocolError(f"buffered frame: {len(body) - off} sample bytes for {count} x {rec.size}")
    samples = [list(rec.unpack_from(body, off + i * rec.size)) for i in range(count)]
    return {"t_first_us": t_first, "interval_us": interval_us, "missed": missed,
            "names": list(names or []), "samples": samples}


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
