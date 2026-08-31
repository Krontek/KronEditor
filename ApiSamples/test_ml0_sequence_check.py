#!/usr/bin/env python3
"""Unit test for ml0_sequence_check's analysis, driven by synthetic ring frames.

Builds frames in the exact /api/v1/stream/ring wire format and feeds them
through the real _apply_frame, so the three verdicts the tool exists to
distinguish are actually exercised:

    lossless (+1 each)  |  uniform decimation (+N each)  |  real loss (irregular)

The third case is built to imitate the failure mode the ring is supposed to rule
out — a buffer that only ever hands back the LATEST value — and asserts the tool
flags it instead of reporting a healthy stream.
"""
import struct
import sys
import unittest

from ml0_sequence_check import SequenceChecker

TASK_ID = 0
PERIOD_US = 10


def info_for(vtype="int64", size=8, name="Var0"):
    return {
        "available": True,
        "layout": {"record_stride": 24,
                   "tasks": [{"task_id": TASK_ID, "period_us": PERIOD_US,
                              "vars": [{"name": name, "type": vtype, "size": size}]}]},
    }


def frame(values, start_seq, stride_n=1, dropped=0, seq_step=1):
    """Pack (seq, value) records into one frame body (after frame_len)."""
    body = struct.pack("<IIQ", len(values), stride_n, dropped)
    seq = start_seq
    for v in values:
        payload = struct.pack("<q", v)
        body += struct.pack("<QHH", seq, TASK_ID, len(payload)) + payload
        seq += seq_step
    return body


def checker():
    c = SequenceChecker("h", 1, "p", "")
    assert c._resolve_layout(info_for()), c.error
    c.connected = True  # verdict() reports 'idle' until the stream is live
    return c


class TestSequenceCheck(unittest.TestCase):

    def test_lossless_stream_is_reported_lossless(self):
        c = checker()
        seq, val = 100, 5000
        for _ in range(20):
            vals = list(range(val, val + 50))
            c._apply_frame(frame(vals, seq))
            seq += 50
            val += 50
        sev, headline, _ = c.verdict()
        self.assertEqual(c.anomaly_count, 0)
        self.assertEqual(c.seq_gaps, 0)
        self.assertEqual(c.var_samples, 1000)
        self.assertEqual(dict(c.step_hist), {1: 999})
        self.assertEqual(sev, "ok")
        self.assertIn("LOSSLESS", headline)

    def test_uniform_decimation_is_not_reported_as_loss(self):
        """stride_N=5 → values step by 5. Thinned, but nothing irregular."""
        c = checker()
        seq, val = 0, 0
        for _ in range(10):
            vals = list(range(val, val + 5 * 40, 5))
            c._apply_frame(frame(vals, seq, stride_n=5))
            seq += 40
            val += 5 * 40
        sev, headline, _ = c.verdict()
        self.assertEqual(c.anomaly_count, 0)
        self.assertEqual(dict(c.step_hist), {5: 399})
        self.assertEqual(sev, "warn")
        self.assertIn("DECIMATION", headline)

    def test_latest_value_only_buffer_is_caught(self):
        """The failure this tool exists for: seq is perfectly contiguous, but the
        values jump irregularly because only the newest value was kept."""
        c = checker()
        # seq contiguous, values leap by ~3000 (as if sampled, not captured)
        vals = [41, 3187, 6902, 9950, 13001]
        c._apply_frame(frame(vals, 0))
        sev, headline, detail = c.verdict()
        self.assertEqual(c.seq_gaps, 0, "transport looked healthy")
        self.assertEqual(c.anomaly_count, 4, "but every value step is wrong")
        self.assertEqual(sev, "bad")
        self.assertIn("LOSS DETECTED", headline)

    def test_ring_seq_gap_is_detected(self):
        c = checker()
        c._apply_frame(frame([1, 2, 3], 0))
        c._apply_frame(frame([9, 10], 8))  # seq jumped 3 -> 8
        self.assertEqual(c.seq_gaps, 1)
        self.assertEqual(c.anomaly_count, 1)  # 3 -> 9 is +6, not +1
        self.assertEqual(c.verdict()[0], "bad")

    def test_stride_change_boundary_is_not_flagged(self):
        """Switching stride makes exactly one step legitimately different."""
        c = checker()
        c._apply_frame(frame([0, 1, 2], 0, stride_n=1))
        c._apply_frame(frame([10, 20, 30], 3, stride_n=10))
        self.assertEqual(c.anomaly_count, 0, f"anomalies: {list(c.anomalies)}")
        self.assertEqual(c.stride_changes, 1)

    def test_other_task_records_do_not_disturb_the_counter(self):
        """Records from a second task interleave; they must be counted in
        total_records and seq continuity but never in the value steps."""
        c = checker()
        body = struct.pack("<IIQ", 4, 1, 0)
        for seq, task, val in ((0, TASK_ID, 7), (1, 9, 999), (2, TASK_ID, 8), (3, 9, 999)):
            payload = struct.pack("<q", val)
            body += struct.pack("<QHH", seq, task, len(payload)) + payload
        c._apply_frame(body)
        self.assertEqual(c.total_records, 4)
        self.assertEqual(c.var_samples, 2)
        self.assertEqual(c.anomaly_count, 0)
        self.assertEqual(dict(c.step_hist), {1: 1})

    def test_attach_backlog_is_not_counted_as_a_streaming_drop(self):
        """The first frame's `dropped` is pre-attach ring history, not our loss."""
        c = checker()
        c._apply_frame(frame([1, 2], 0, dropped=50_000))
        c._apply_frame(frame([3, 4], 2, dropped=50_000))
        sev, headline, _ = c.verdict()
        self.assertEqual(c.attach_backlog, 50_000)
        self.assertEqual(sev, "ok", headline)

    def test_drifting_stride_does_not_fabricate_anomalies(self):
        """Regression: the server re-tunes the stride every 100 ms. Steps that
        merely disagree with the CURRENT stride (because the producer's phase
        reset) must not be reported as device loss — that made a healthy,
        decimated stream read as 'LOSS DETECTED'."""
        c = checker()
        seq, val = 0, 0
        for stride in (1653, 1643, 1633, 1623, 1614):
            vals = []
            for _ in range(8):
                val += stride
                vals.append(val)
            c._apply_frame(frame(vals, seq, stride_n=stride))
            seq += 8
        self.assertEqual(c.anomaly_count, 0, f"anomalies: {list(c.anomalies)}")
        self.assertEqual(c.verdict()[0], "warn")

    def test_step_smaller_than_stride_is_never_loss(self):
        """More samples than the stride promised cannot be caused by lapping."""
        c = checker()
        c._apply_frame(frame([0, 1000, 1400, 2400], 0, stride_n=1000))
        self.assertEqual(c.anomaly_count, 0, f"anomalies: {list(c.anomalies)}")

    def test_oversized_step_is_still_caught_while_decimating(self):
        """A jump far beyond what the stride can explain is real loss."""
        c = checker()
        c._apply_frame(frame([0, 1000, 2000, 90000], 0, stride_n=1000))
        self.assertEqual(c.anomaly_count, 1)
        self.assertEqual(c.verdict()[0], "bad")

    def test_backwards_value_is_caught(self):
        c = checker()
        c._apply_frame(frame([500, 400], 0))
        self.assertEqual(c.anomaly_count, 1)

    def test_non_integer_variable_is_rejected(self):
        c = SequenceChecker("h", 1, "p", "")
        self.assertFalse(c._resolve_layout(info_for(vtype="float64")))
        self.assertIn("INTEGER counter", c.error)

    def test_unknown_variable_name_lists_what_exists(self):
        c = SequenceChecker("h", 1, "p", "Nope")
        self.assertFalse(c._resolve_layout(info_for()))
        self.assertIn("Var0", c.error)


if __name__ == "__main__":
    unittest.main(verbosity=2)
