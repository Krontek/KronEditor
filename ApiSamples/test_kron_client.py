#!/usr/bin/env python3
"""Offline test of kron_client's ring decoder — no device, no network.

Builds frames in the exact /api/v1/stream/ring wire format and checks that a
record's payload is sliced in layout order, that multiple tasks with different
payload widths each decode with their own field list, and that the frame's
decimation / loss counters survive decoding.

Run:  python3 test_kron_client.py     (or: python3 -m pytest test_kron_client.py)
"""
import struct
import unittest

from kron_client import decode_ring_frame, ring_decoders

LAYOUT = {
    "record_stride": 32,
    "tasks": [
        {"task_id": 0, "period_us": 100, "vars": [
            {"name": "counter", "type": "int64", "size": 8},
            {"name": "flag", "type": "bool", "size": 1},
        ]},
        {"task_id": 1, "period_us": 1000, "vars": [
            {"name": "speed", "type": "float32", "size": 4},
        ]},
    ],
}


def frame_body(records, stride_n=1, dropped=0):
    """records = [(seq, task_id, payload_bytes), ...] -> body after frame_len."""
    body = struct.pack("<IIQ", len(records), stride_n, dropped)
    for seq, task_id, payload in records:
        body += struct.pack("<QHH", seq, task_id, len(payload)) + payload
    return body


class RingDecodeTest(unittest.TestCase):
    def setUp(self):
        self.decoders = ring_decoders(LAYOUT)

    def test_fields_decode_in_layout_order(self):
        payload = struct.pack("<q?", 1234567890123, True)
        out = decode_ring_frame(frame_body([(7, 0, payload)]), self.decoders)
        seq, task_id, values = out["records"][0]
        self.assertEqual((seq, task_id), (7, 0))
        self.assertEqual(values, {"counter": 1234567890123, "flag": True})

    def test_tasks_use_their_own_field_list(self):
        recs = [(1, 0, struct.pack("<q?", 5, False)),
                (2, 1, struct.pack("<f", 1.5))]
        out = decode_ring_frame(frame_body(recs), self.decoders)
        self.assertEqual(out["records"][0][2], {"counter": 5, "flag": False})
        self.assertEqual(out["records"][1][2], {"speed": 1.5})

    def test_counters_survive_decoding(self):
        out = decode_ring_frame(
            frame_body([(9, 1, struct.pack("<f", 0.25))], stride_n=8, dropped=42),
            self.decoders)
        self.assertEqual(out["stride_n"], 8)      # decimation, not loss
        self.assertEqual(out["dropped_total"], 42)

    def test_seq_is_contiguous_across_tasks(self):
        recs = [(100, 0, struct.pack("<q?", 1, True)),
                (101, 1, struct.pack("<f", 2.0)),
                (102, 0, struct.pack("<q?", 2, True))]
        out = decode_ring_frame(frame_body(recs), self.decoders)
        seqs = [r[0] for r in out["records"]]
        self.assertEqual(seqs, [100, 101, 102])

    def test_short_payload_does_not_raise(self):
        # A truncated payload must drop the unreadable field, not blow up the
        # whole frame — one bad record would otherwise kill a live capture.
        out = decode_ring_frame(frame_body([(1, 0, struct.pack("<q", 5))]),
                                self.decoders)
        self.assertEqual(out["records"][0][2], {"counter": 5})


if __name__ == "__main__":
    unittest.main(verbosity=2)
