#!/usr/bin/env python3
"""Offline test of kron_client's ring decoder — no device, no network.

Builds frames in the exact /api/v1/stream/ring wire format and checks that a
record's payload is sliced in layout order, that multiple tasks with different
payload widths each decode with their own field list, and that the frame's
decimation / loss counters survive decoding.

Run:  python3 test_kron_client.py     (or: python3 -m pytest test_kron_client.py)
"""
import io
import struct
import unittest

from kron_client import (KronClient, KronProtocolError, decode_buffered_frame,
                         decode_ring_frame, format_iec_time, parse_json_body,
                         read_ring_frames, ring_decoders, time_us)

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


def frame_body(records, stride_n=1, dropped=0, epoch=1):
    """records = [(seq, task_id, payload_bytes[, scan]), ...] -> v2 body after frame_len."""
    body = struct.pack("<HHIIQQ", 2, 28, len(records), stride_n, dropped, epoch)
    for rec in records:
        seq, task_id, payload = rec[:3]
        scan = rec[3] if len(rec) > 3 else seq
        body += struct.pack("<QHHI", seq, task_id, len(payload), scan) + payload
    return body


class RingDecodeTest(unittest.TestCase):
    def setUp(self):
        self.decoders = ring_decoders(LAYOUT)

    def test_fields_decode_in_layout_order(self):
        payload = struct.pack("<q?", 1234567890123, True)
        out = decode_ring_frame(frame_body([(7, 0, payload)]), self.decoders)
        seq, task_id, values, scan = out["records"][0]
        self.assertEqual((seq, task_id, scan), (7, 0, 7))
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



class RingV2Test(unittest.TestCase):
    def setUp(self):
        self.decoders = ring_decoders(LAYOUT)

    def test_epoch_and_scan_survive(self):
        out = decode_ring_frame(frame_body([(3, 1, struct.pack("<f", 1.0), 0xFFFFFFF0)],
                                           epoch=77), self.decoders)
        self.assertEqual(out["epoch"], 77)
        self.assertEqual(out["records"][0][3], 0xFFFFFFF0)

    def test_v1_frame_is_refused_not_misparsed(self):
        v1 = struct.pack("<IIQ", 1, 1, 0) + struct.pack("<QHH", 1, 0, 1) + b"\x01"
        with self.assertRaises(KronProtocolError):
            decode_ring_frame(v1, self.decoders)

    def test_larger_header_len_is_skipped(self):
        # A later version may append header fields; header_len says where
        # records start, so this client keeps working.
        body = frame_body([(5, 1, struct.pack("<f", 2.0))])
        body = body[:2] + struct.pack("<H", 36) + body[4:28] + b"\0" * 8 + body[28:]
        self.assertEqual(decode_ring_frame(body, self.decoders)["records"][0][2], {"speed": 2.0})

    def test_epoch_change_refetches_layout(self):
        new_layout = {"tasks": [{"task_id": 1, "period_us": 1000,
                                 "vars": [{"name": "temp", "type": "int32", "size": 4}]}]}
        wire = b"".join(struct.pack("<I", len(b)) + b for b in [
            frame_body([(1, 1, struct.pack("<f", 1.5))], epoch=1),
            frame_body([], epoch=2),
            frame_body([(9, 1, struct.pack("<i", -4))], epoch=2),
        ])

        class Resp(io.BytesIO):
            pass

        c = KronClient()
        c._request = lambda *a, **k: Resp(wire)
        c.ring_info = lambda: {"available": True, "layout": new_layout}
        frames = list(c.stream_ring_frames(LAYOUT))
        self.assertEqual(frames[0]["records"][0][2], {"speed": 1.5})
        self.assertTrue(frames[1]["epoch_changed"])
        self.assertEqual(frames[2]["records"][0][2], {"temp": -4})
        self.assertFalse(frames[2]["epoch_changed"])


class BufferedV2Test(unittest.TestCase):
    def test_decode(self):
        types = bytes([9, 7])                 # float32, int64
        samples = struct.pack("<fq", 1.5, 2**60) + struct.pack("<fq", 2.5, -1)
        body = struct.pack("<HHIIIQ", 2, 2, 2, 1000, 3, 123456) + types + samples
        f = decode_buffered_frame(body, ["a", "b"])
        self.assertEqual((f["t_first_us"], f["interval_us"], f["missed"]), (123456, 1000, 3))
        self.assertEqual(f["samples"], [[1.5, 2**60], [2.5, -1]])

    def test_wide_var_count(self):
        n = 300                               # v1's u8 count wrapped here
        body = struct.pack("<HHIIIQ", 2, n, 1, 100, 0, 1) + bytes([2] * n) + bytes(range(256)) + bytes(44)
        self.assertEqual(len(decode_buffered_frame(body)["samples"][0]), n)

    def test_size_mismatch_raises(self):
        body = struct.pack("<HHIIIQ", 2, 1, 2, 100, 0, 1) + bytes([5]) + b"\0" * 4
        with self.assertRaises(KronProtocolError):
            decode_buffered_frame(body)


class TimeTypeTest(unittest.TestCase):
    """IEC TIME/LTIME = int64 microseconds (signed), published as "int64"."""

    def test_ring_decodes_time_as_signed_64bit(self):
        layout = {"tasks": [{"task_id": 0, "vars": [
            {"name": "delay", "type": "int64", "size": 8},     # TIME, T#2h
            {"name": "offset", "type": "int64", "size": 8},    # TIME, T#-5s
        ]}]}
        payload = struct.pack("<qq", 7_200_000_000, -5_000_000)
        out = decode_ring_frame(frame_body([(1, 0, payload)]), ring_decoders(layout))
        self.assertEqual(out["records"][0][2], {"delay": 7_200_000_000, "offset": -5_000_000})

    def test_buffered_decodes_time_as_signed_64bit(self):
        body = struct.pack("<HHIIIQ", 2, 1, 2, 1000, 0, 1) + bytes([7]) + struct.pack("<qq", -5_000_000, 2**33)
        self.assertEqual(decode_buffered_frame(body)["samples"], [[-5_000_000], [2**33]])

    def test_time_helpers(self):
        self.assertEqual(time_us("9007199254740993"), 9007199254740993)   # > 2^53 arrives as a string
        self.assertEqual(format_iec_time(7_200_000_000), "T#2h")
        self.assertEqual(format_iec_time(-5_000_000), "T#-5s")
        self.assertEqual(format_iec_time("90061000001"), "T#1d1h1m1s1us")
        self.assertEqual(format_iec_time(0), "T#0s")


class StreamFramingTest(unittest.TestCase):
    """The length-prefixed framing around decode_ring_frame."""

    def setUp(self):
        self.decoders = ring_decoders(LAYOUT)

    def wire(self, *bodies):
        return b"".join(struct.pack("<I", len(b)) + b for b in bodies)

    def test_reads_consecutive_frames_then_stops_cleanly(self):
        b1 = frame_body([(1, 0, struct.pack("<q?", 1, True))])
        b2 = frame_body([(2, 1, struct.pack("<f", 3.0))], dropped=4)
        frames = list(read_ring_frames(io.BytesIO(self.wire(b1, b2)), self.decoders))
        self.assertEqual([f["records"][0][0] for f in frames], [1, 2])
        self.assertEqual(frames[1]["dropped_total"], 4)

    def test_truncated_body_raises_instead_of_decoding_garbage(self):
        b1 = frame_body([(1, 0, struct.pack("<q?", 1, True))])
        data = self.wire(b1)[:-3]
        with self.assertRaises(KronProtocolError):
            list(read_ring_frames(io.BytesIO(data), self.decoders))

    def test_truncated_header_raises(self):
        with self.assertRaises(KronProtocolError):
            list(read_ring_frames(io.BytesIO(b"\x10\x00"), self.decoders))


class JsonBodyTest(unittest.TestCase):
    def test_empty_body_is_an_error_not_an_empty_dict(self):
        for raw in (b"", b"  \n"):
            with self.assertRaises(KronProtocolError):
                parse_json_body(raw, "GET /api/v1/variables")

    def test_null_values_survive(self):
        # NaN/Inf REALs arrive as JSON null.
        self.assertEqual(parse_json_body(b'{"x": null, "y": 1.5}'), {"x": None, "y": 1.5})


if __name__ == "__main__":
    unittest.main(verbosity=2)
