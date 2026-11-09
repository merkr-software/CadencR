"""Regressions for the pinned tsgo shutdown transport and strict exit verdicts."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock

from native_semantic import FIXTURES, exercise, shutdown, shutdown_result, shutdown_transport, wait_for_exit
from node_smoke import Connection


ROOT = Path(__file__).resolve().parents[2]
SERVER = r'''
import json, sys
stream = sys.stdin.buffer
stopped = False
while True:
    headers = {}
    while (line := stream.readline()) not in (b"\r\n", b"\n", b""):
        key, value = line.decode().split(":", 1)
        headers[key.lower()] = value.strip()
    if not line:
        raise SystemExit(int(sys.argv[1]) if stopped else 19)
    message = json.loads(stream.read(int(headers["content-length"])))
    if message["method"] == "exit":
        # Model the preview's fatal context cancellation on protocol exit.
        raise SystemExit(1)
    if "id" not in message:
        continue
    result = {"capabilities": {}} if message["method"] == "initialize" else None
    if message["method"] == "textDocument/diagnostic":
        result = {"kind": "full", "items": [{"code": 2322}]}
    if message["method"] == "shutdown":
        stopped = True
    raw = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode()
    sys.stdout.buffer.write(b"Content-Length: " + str(len(raw)).encode() + b"\r\n\r\n" + raw)
    sys.stdout.buffer.flush()
'''


class NativeShutdownTests(unittest.TestCase):
    def test_reviewed_tsgo_uses_acknowledged_shutdown_and_eof_without_masking_exit_errors(self):
        recipe = json.loads((ROOT / "plugins/lsp/native-recipes/tsgo.json").read_text())
        for exit_code in (0, 23):
            with self.subTest(exit_code=exit_code):
                process = subprocess.Popen([sys.executable, "-u", "-c", SERVER, str(exit_code)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
                try:
                    connection = Connection(process, lambda section: {})
                    report = exercise(connection, Path("/workspace"), Path("/workspace/main.ts"),
                        FIXTURES["tsgo"], {}, shutdown_transport(recipe))
                    self.assertEqual(report["result"]["items"], [{"code": 2322}])
                    self.assertEqual(report["shutdown"], {"transport": "stdin-eof", "exit_notification": False, "result": None})
                    self.assertEqual(wait_for_exit(process, timeout=1), exit_code)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    process.stdin.close()
                    process.stdout.close()

    def test_eof_workaround_does_not_apply_to_other_versions_or_servers(self):
        for identifier, version in (("tsgo", "new-version"), ("ruff", "7.0.0-dev.20260707.2")):
            with self.subTest(identifier=identifier, version=version):
                self.assertEqual(shutdown_transport({"id": identifier, "version": version}), "exit")

    def test_reviewed_luals_boolean_acknowledgement_is_recorded_before_protocol_exit(self):
        recipe = json.loads((ROOT / "plugins/lsp/native-recipes/lua-language-server.json").read_text())
        connection = Mock()
        connection.wait.return_value = {"id": 3, "jsonrpc": "2.0", "result": True}
        report = shutdown(connection, shutdown_transport(recipe), shutdown_result(recipe))
        self.assertEqual(report, {"transport": "exit", "exit_notification": True, "result": True})
        self.assertEqual(connection.send.call_args_list[-1].args[0], {"method": "exit"})
        connection.process.stdin.close.assert_not_called()

    def test_luals_compatibility_rejects_missing_false_numeric_and_other_results(self):
        recipe = json.loads((ROOT / "plugins/lsp/native-recipes/lua-language-server.json").read_text())
        for reply in ({}, {"result": False}, {"result": 1}, {"result": "true"}, {"result": None}):
            with self.subTest(reply=reply):
                connection = Mock()
                connection.wait.return_value = reply
                with self.assertRaisesRegex(ValueError, "true result"):
                    shutdown(connection, "exit", shutdown_result(recipe))
                connection.process.stdin.close.assert_not_called()
                self.assertEqual(connection.send.call_count, 1)

    def test_boolean_acknowledgement_is_not_allowed_for_other_versions_or_servers(self):
        for identifier, version in (("lua-language-server", "new-version"), ("tsgo", "3.19.2"), ("ruff", "3.19.2")):
            with self.subTest(identifier=identifier, version=version):
                connection = Mock()
                connection.wait.return_value = {"result": True}
                with self.assertRaisesRegex(ValueError, "null result"):
                    shutdown(connection, "exit", shutdown_result({"id": identifier, "version": version}))
                self.assertEqual(connection.send.call_count, 1)

    def test_shutdown_failure_does_not_close_transport_or_send_exit(self):
        for reply in ({}, {"result": False}, {"result": {}}):
            with self.subTest(reply=reply):
                connection = Mock()
                connection.wait.return_value = reply
                with self.assertRaisesRegex(ValueError, "null result"):
                    shutdown(connection, "stdin-eof")
                connection.process.stdin.close.assert_not_called()
                self.assertEqual(connection.send.call_count, 1)
        connection = Mock()
        connection.wait.side_effect = ValueError("shutdown LSP error")
        with self.assertRaisesRegex(ValueError, "shutdown LSP error"):
            shutdown(connection, "stdin-eof")
        connection.process.stdin.close.assert_not_called()


if __name__ == "__main__":
    unittest.main()
