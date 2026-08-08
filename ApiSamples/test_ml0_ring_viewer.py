"""Deterministic unit test of the ring-frame decoder used by ml0_ring_viewer.

Builds synthetic /stream/ring frames (the exact wire format the server emits)
and checks per-variable value + running count, multi-variable payload offsets,
and cumulative counting across frames. No network / GUI / binaries needed.

Run:  python3 -m pytest apisamples/test_ml0_ring_viewer.py   (or just: python3 apisamples/test_ml0_ring_viewer.py)
"""
import struct
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from ml0_ring_viewer import RingReader


def build_frame(records, stride_n=1, dropped=0):
    """records = [(seq, task_id, payload_bytes), ...] -> full frame incl. length prefix."""
    body = struct.pack("<IIQ", len(records), stride_n, dropped)
    for seq, tid, payload in records:
        body += struct.pack("<QHH", seq, tid, len(payload)) + payload
    return struct.pack("<I", len(body)) + body


def make_reader(vars_):
    r = RingReader("h", "1", "p", len(vars_))
    r.vars = vars_
    r._wanted_tasks = {v["task_id"] for v in vars_}
    return r


def test_single_lint_counts_and_current_value():
    r = make_reader([{"ml": 0, "name": "var1", "fmt": "q", "size": 8,
                      "task_id": 0, "poff": 0, "count": 0, "value": None}])
    recs = [(i, 0, struct.pack("<q", 100 + i)) for i in range(5)]
    frame = build_frame(recs)
    body = frame[4:]  # strip length prefix (the reader does this before _apply_frame)
    r._apply_frame(body)
    assert r.total_records == 5, r.total_records
    assert r.vars[0]["count"] == 5
    assert r.vars[0]["value"] == 104   # last value
    print("ok single: count=5 current=104")


def test_cumulative_across_frames():
    r = make_reader([{"ml": 0, "name": "var1", "fmt": "q", "size": 8,
                      "task_id": 0, "poff": 0, "count": 0, "value": None}])
    for base in (0, 3, 6):
        recs = [(base + i, 0, struct.pack("<q", base + i)) for i in range(3)]
        r._apply_frame(build_frame(recs)[4:])
    assert r.vars[0]["count"] == 9, r.vars[0]["count"]
    assert r.vars[0]["value"] == 8
    assert r.total_records == 9
    print("ok cumulative: count=9 current=8")


def test_two_vars_same_task_payload_offsets():
    # two LINTs packed in one task record: %ML0 at payload off 0, %ML1 at off 8
    vars_ = [
        {"ml": 0, "name": "a", "fmt": "q", "size": 8, "task_id": 0, "poff": 0, "count": 0, "value": None},
        {"ml": 1, "name": "b", "fmt": "q", "size": 8, "task_id": 0, "poff": 8, "count": 0, "value": None},
    ]
    r = make_reader(vars_)
    recs = []
    for i in range(4):
        payload = struct.pack("<qq", 1000 + i, 2000 + i)
        recs.append((i, 0, payload))
    r._apply_frame(build_frame(recs)[4:])
    assert r.vars[0]["count"] == 4 and r.vars[0]["value"] == 1003
    assert r.vars[1]["count"] == 4 and r.vars[1]["value"] == 2003
    print("ok two-vars: ML0 current=1003 ML1 current=2003, both count=4")


def test_stride_and_dropped_surface():
    r = make_reader([{"ml": 0, "name": "v", "fmt": "q", "size": 8,
                      "task_id": 0, "poff": 0, "count": 0, "value": None}])
    r._apply_frame(build_frame([(0, 0, struct.pack("<q", 7))], stride_n=5, dropped=42)[4:])
    assert r.stride_n == 5 and r.dropped == 42
    print("ok stride/dropped: stride_N=5 dropped=42 surfaced")


if __name__ == "__main__":
    test_single_lint_counts_and_current_value()
    test_cumulative_across_frames()
    test_two_vars_same_task_payload_offsets()
    test_stride_and_dropped_surface()
    print("\nALL DECODER TESTS PASSED")
