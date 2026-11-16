"""Exercise the exact native release executable with the scripted Cursor CLI.

No credentials, installed provider state, or paid model is used. This is native
connector conformance, not evidence of a real Cursor service integration test.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import selectors
import subprocess
import tempfile
import time


class Host:
    def __init__(self, binary, env, cwd):
        self.process = subprocess.Popen(
            [str(binary), "run", "--protocol", "acp-v1"], cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        self.next_id = 0
        self.updates = []

    def read(self, deadline):
        while b"\n" not in self.buffer:
            if not self.selector.select(max(0, deadline - time.monotonic())):
                raise TimeoutError("connector response timed out")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("connector closed stdout before replying")
            self.buffer += chunk
            if len(self.buffer) > 1024 * 1024:
                raise RuntimeError("connector response exceeds qualification limit")
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def request(self, method, params):
        self.next_id += 1
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": self.next_id,
                                             "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + 30
        while True:
            message = self.read(deadline)
            if message.get("id") == self.next_id and "method" not in message:
                if "error" in message:
                    raise RuntimeError(f"{method} failed: {message['error']}")
                return message["result"]
            if "id" in message and "method" in message:
                raise RuntimeError("unexpected connector permission request")
            self.updates.append(message)

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
            raise RuntimeError("connector did not exit after stdin closed")
        finally:
            self.selector.close()
            self.process.stdout.close()
            diagnostics = self.process.stderr.read(65536)
            self.process.stderr.close()
        if self.process.returncode:
            raise RuntimeError(f"connector exited {self.process.returncode}: {diagnostics!r}")


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def exercise(binary, fixture, version, scratch):
    env = {"PATH": os.environ["PATH"], "HOME": str(scratch / "home"),
           "CADENCR_CURSOR_COMMAND": str(fixture),
           "FAKE_AGENT_LOG": str(scratch / "agent.jsonl")}
    (scratch / "home").mkdir()
    def command(*args):
        return subprocess.check_output([str(binary), *args], cwd=scratch, env=env, timeout=30)
    check(command("version").decode().strip() == version, "connector version mismatch")
    options = json.loads(command("models", "--format", "acp-config-options-v1", "--cwd", str(scratch)))
    check([item["id"] for item in options] == ["mode", "model", "access"], "invalid cold selectors")
    model = next(item for item in options if item["id"] == "model")
    check(model["currentValue"] == "composer-2.5", "cold model selection mismatch")
    integration = json.loads(command("host-integration", "--format", "cadencr-host-integration-v1"))
    check(".cursor/rules" in integration["worktreeConfigPaths"], "worktree integration missing")
    host = Host(binary, env, scratch)
    try:
        initialized = host.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        check(initialized["protocolVersion"] == 1, "ACP initialization mismatch")
        created = host.request("session/new", {"cwd": str(scratch), "mcpServers": []})
        session = created["sessionId"]
        live = next(item for item in created["configOptions"] if item["id"] == "model")
        check(live["currentValue"] == model["currentValue"], "cold/live model mismatch")
        selected = host.request("session/set_config_option", {
            "sessionId": session, "configId": "model", "value": "gpt-5.3-codex-high-fast"})
        check(next(item for item in selected["configOptions"] if item["id"] == "model")["currentValue"]
              == "gpt-5.3-codex-high-fast", "model reconciliation failed")
        result = host.request("session/prompt", {"sessionId": session,
                              "prompt": [{"type": "text", "text": "native qualification"}]})
        check(result["stopReason"] == "end_turn", "scripted turn failed")
        check(any("echo native qualification" in json.dumps(item) for item in host.updates),
              "scripted reply missing")
        host.request("session/load", {"sessionId": session, "cwd": str(scratch), "mcpServers": []})
        host.request("session/set_config_option", {
            "sessionId": session, "configId": "access", "value": "full_access"})
    finally:
        host.close()
    return ["version", "cold-models", "host-integration", "initialize", "session-new",
            "model-reconciliation", "scripted-prompt", "session-load", "access-restart", "stdin-close"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=pathlib.Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    machine = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64"}.get(platform.machine())
    check(args.target == f"{system}-{machine}", "qualification must execute on the declared native target")
    root = pathlib.Path(__file__).resolve().parent.parent
    version = json.loads((root / "package.json").read_text())["version"]
    binary = args.binary.resolve(strict=True)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="cursor-qualification-"))
    print(f"Qualification scratch retained: {scratch}")
    checks = exercise(binary, root / "tests/fixtures/fake_agent.py", version, scratch)
    evidence = {"schema_version": 1, "target": args.target, "source_commit": args.source_commit,
                "version": version, "executable_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "runtime": "scripted-cursor-cli", "real_cursor_cli": False, "checks": checks, "result": "PASS"}
    with args.output.open("x") as output:
        json.dump(evidence, output, sort_keys=True, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
