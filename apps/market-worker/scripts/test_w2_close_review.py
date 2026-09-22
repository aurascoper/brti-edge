import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("repaired_w2", ROOT / "w2_close_check.py")
w2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w2)
PASS = "gates: G1(PASS) G2(PASS) G3(PASS) G6(PASS) G7(PASS)   [G2 bound z≥1.7]\n"
T0 = w2.ts_ms("2026-09-24T10:00:00Z")
T1 = w2.ts_ms("2026-10-08T10:00:00Z")
TICKER = "KXBTC15M-26SEP241030-30"
CLOSE = "2026-09-24T10:30:00Z"


class GateTests(unittest.TestCase):
    def test_complete_gate_line_passes(self):
        self.assertEqual(w2.verdict(0, PASS, False)[1], 0)
        self.assertIn("GO — full battery", w2.verdict(0, PASS, False)[0])

    def test_incomplete_or_unknown_gate_line_cannot_go(self):
        for text in ("gates: G1(PASS)", "gates: unknown", "gates:",
                     PASS.replace("G7(PASS)", "G7(MAYBE)"),
                     PASS.replace("G7(PASS)", "G2(PASS)"),
                     PASS.replace("G7(PASS)", "G8(PASS)"),
                     PASS + PASS, PASS.replace("[G2 bound z≥1.7]", "trailing junk")):
            with self.subTest(text=text):
                verdict, code = w2.verdict(0, text, False)
                self.assertEqual(code, 1)
                self.assertIn("NO-GO (integrity)", verdict)

    def test_known_failures_keep_their_quadrants(self):
        for gate, quadrant in (("G1", "economics"), ("G3", "execution"), ("G7", "mechanism")):
            with self.subTest(gate=gate):
                line, code = w2.verdict(0, PASS.replace(gate+"(PASS)", gate+"(FAIL)"), False)
                self.assertEqual(code, 0)  # process success is NOT a trading GO
                self.assertIn("NO-GO ("+quadrant+")", line)

    def test_scorer_crash_and_tripwire_refuse(self):
        self.assertEqual(w2.verdict(1, PASS, False)[1], 1)
        self.assertIn("NO-GO (data)", w2.verdict(0, "TRIPWIRE\n"+PASS, False)[0])

    def test_interim_accepts_only_one_exact_boolean_line(self):
        for good in ("GO", "CONTINUE"):
            self.assertEqual(w2.verdict(0, good+"\n", True), (good, 0))
        for bad in ("", "noise\nGO", "GO\nCONTINUE", "unknown", "GO — full battery PASS"):
            with self.subTest(bad=bad):
                self.assertEqual(w2.verdict(0, bad, True), ("NO-GO (integrity)", 1))


class SettlementTests(unittest.TestCase):
    def rec(self, local=None, exchange=None):
        local = local if local is not None else [{"ticker":TICKER, "close_time":CLOSE, "kalshi_result":"yes"}]
        exchange = exchange if exchange is not None else [{"ticker":TICKER, "close_time":CLOSE, "result":"yes"}]
        with patch.object(w2, "load_jsonl", return_value=iter(local)):
            return w2.reconcile(exchange, T0, T1)

    def test_matching_authoritative_outcome_passes(self):
        self.assertTrue(self.rec()["integrity_ok"])

    def test_opposite_outcome_is_refused(self):
        rec = self.rec(exchange=[{"ticker":TICKER, "close_time":CLOSE, "result":"no"}])
        self.assertFalse(rec["integrity_ok"])
        self.assertEqual(rec["conflicts"], [TICKER])

    def test_close_identity_mismatch_is_refused(self):
        rec = self.rec(exchange=[{"ticker":TICKER,"close_time":"2026-09-24T10:45:00Z","result":"yes"}])
        self.assertFalse(rec["integrity_ok"])

    def test_empty_listing_never_passes(self):
        self.assertFalse(self.rec(exchange=[])["integrity_ok"])
        self.assertFalse(self.rec(local=[], exchange=[])["integrity_ok"])

    def test_duplicate_same_identity_allowed_conflict_refused(self):
        row = {"ticker":TICKER, "close_time":CLOSE, "kalshi_result":"yes"}
        self.assertTrue(self.rec(local=[row,row])["integrity_ok"])
        rec = self.rec(local=[row,{**row,"kalshi_result":"no"}])
        self.assertFalse(rec["integrity_ok"])
        self.assertIn("conflicting duplicate", rec["problems"][0])

    def test_conflicting_duplicate_across_window_boundary_is_refused(self):
        row = {"ticker":TICKER, "close_time":CLOSE, "kalshi_result":"yes"}
        rec = self.rec(local=[row,{**row,"close_time":"2026-10-09T10:30:00Z"}])
        self.assertFalse(rec["integrity_ok"])

    def test_extra_local_settlement_is_refused(self):
        row = {"ticker":TICKER, "close_time":CLOSE, "kalshi_result":"yes"}
        rec = self.rec(local=[row,{**row,"ticker":TICKER+"-EXTRA"}])
        self.assertFalse(rec["integrity_ok"])

    def test_malformed_authoritative_result_and_naive_time_fail(self):
        for changes in ({"result":"unknown"}, {"close_time":"2026-09-24T10:30:00"}, {"close_time":"bad"}):
            with self.subTest(changes=changes):
                rec = self.rec(exchange=[{"ticker":TICKER,"close_time":CLOSE,"result":"yes",**changes}])
                self.assertFalse(rec["integrity_ok"])


if __name__ == "__main__":
    unittest.main()
