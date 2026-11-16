"""The runtime probe must launch with the same declared options as the app."""
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from node_smoke import evidence_value, exercise, initialization_options, launch_command


class InitializationContractTest(unittest.TestCase):
    def test_empty_host_keeps_published_baseline_typing_acquisition_policy(self):
        recipe = {"initialization_options": {"disableAutomaticTypingAcquisition": True}}
        self.assertEqual(initialization_options(recipe, Path("/bundle"), True),
                         {"disableAutomaticTypingAcquisition": True})
        self.assertEqual(recipe["initialization_options"], {"disableAutomaticTypingAcquisition": True})

    def test_empty_host_does_not_inject_an_unpublished_sdk_assumption(self):
        self.assertEqual(initialization_options({"initialization_options": {}}, Path("/bundle"), True), {})


class EvidenceTest(unittest.TestCase):
    def completion(self, match):
        return {"isIncomplete": False, "items": [
            {"label": "item", "documentation": "x" * 16384} for _ in range(512)
        ] + [{"label": "bg-red-500" if match else "unrelated"}]}

    def connection(self, result):
        replies = iter([{"result": {"capabilities": {}}}, {"result": result}, {"result": None}])
        return SimpleNamespace(send=lambda message: None, wait=lambda predicate: next(replies),
                               process=SimpleNamespace(stdin=io.StringIO()))

    def test_completion_assertions_use_the_full_reply_before_evidence_is_bounded(self):
        result = self.completion(True)
        fixture = {"language": "html", "text": "", "expected": "bg-red", "feature": "completion"}
        report = exercise(self.connection(result), Path("/workspace"), Path("/workspace/file.html"),
                          fixture, {}, True)
        summary = report["result"]
        raw = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        self.assertGreater(len(raw), 8 * 1024 * 1024)
        self.assertTrue(summary["truncated"])
        self.assertEqual(summary["json_bytes"], len(raw))
        self.assertEqual(summary["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(summary["item_count"], 513)
        self.assertNotIn("bg-red", summary["preview"])
        self.assertLess(len(json.dumps(report).encode()), 16384)

    def test_large_nonmatching_completion_still_fails(self):
        fixture = {"language": "html", "text": "", "expected": "bg-red", "feature": "completion"}
        with patch("node_smoke.time.monotonic", side_effect=[0, 16]):
            with self.assertRaisesRegex(ValueError, "did not match expected content"):
                exercise(self.connection(self.completion(False)), Path("/workspace"),
                         Path("/workspace/file.html"), fixture, {}, True)

    def test_small_evidence_is_retained_and_large_failure_payloads_are_bounded(self):
        value = {"message": "type error", "code": 2322}
        self.assertIs(evidence_value(value), value)
        failures = [evidence_value({"error": "x" * (256 * 1024)}) for _ in range(30)]
        self.assertLess(len(json.dumps({"failure_messages": failures}).encode()), 256 * 1024)


class NamespaceTest(unittest.TestCase):
    def test_linux_uses_the_active_network_namespace_interface_inventory(self):
        with patch("node_smoke.sys.platform", "linux"), patch("node_smoke.socket.if_nameindex", return_value=[(1, "lo")]):
            self.assertEqual(launch_command(Path("/node"), Path("/server.js"), ["--stdio"], []),
                             ["/node", "/server.js", "--stdio"])
        with patch("node_smoke.sys.platform", "linux"), patch("node_smoke.socket.if_nameindex", return_value=[(1, "lo"), (2, "eth0")]):
            with self.assertRaisesRegex(ValueError, "deny-network namespace"):
                launch_command(Path("/node"), Path("/server.js"), [], [])


if __name__ == "__main__":
    unittest.main()
