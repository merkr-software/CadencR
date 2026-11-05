"""Run real LSP features with no credentials, no npm and denied network.

The protocol reader/sender is shared with the native LSP harness. A passing
probe reports only its exact language feature and current OS/architecture.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lsp-native-prepare"))
from smoke import reader, send
from node_fixtures import prepare_workspace, settings


class Connection:
    def __init__(self, process, configuration):
        self.process, self.configuration = process, configuration
        self.messages, self.received = queue.Queue(maxsize=1024), []
        threading.Thread(target=reader, args=(process.stdout, self.messages), daemon=True).start()

    def send(self, message):
        send(self.process, message)

    def wait(self, predicate, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty as error:
                raise TimeoutError("no matching real language feature response") from error
            if isinstance(message, Exception):
                raise message
            if len(self.received) >= 1024:
                raise ValueError("too many server messages")
            self.received.append(message)
            if "id" in message and "method" in message:
                if message["method"] == "workspace/configuration":
                    result = [self.configuration(item.get("section")) for item in message["params"]["items"]]
                else:
                    result = None
                self.send({"id": message["id"], "result": result})
            if message.get("method") == "tsserver/request":
                raise ValueError("Vue requires host tsserver/request bridge; hybridMode false is not supported by this distribution")
            if predicate(message):
                if "error" in message:
                    raise ValueError("language server returned an LSP error: " + json.dumps(message["error"]))
                return message
        raise TimeoutError("no matching real language feature response")


def launch_command(node, entry, args, read_only_roots):
    command = [str(node), str(entry), *args]
    if sys.platform == "darwin":
        sandbox = Path("/usr/bin/sandbox-exec")
        if not sandbox.is_file():
            raise ValueError("active deny-network sandbox is required")
        profile = "(version 1)(allow default)(deny network*)"
        for root in read_only_roots:
            profile += "(deny file-write* (subpath " + json.dumps(str(root.resolve())) + "))"
        return [str(sandbox), "-p", profile, *command]
    if sys.platform == "linux":
        if {path.name for path in Path("/sys/class/net").iterdir()} - {"lo"}:
            raise ValueError("run within an unprivileged deny-network namespace")
        return command
    raise ValueError("supported macOS or Linux runtime required")


def initialization_options(recipe, bundle, empty_host_settings):
    options = {} if empty_host_settings else {
        "typescript": {"tsdk": str(bundle / "node_modules/typescript/lib")},
        "disableAutomaticTypingAcquisition": True}
    return {**options, **recipe.get("initialization_options", {})}


def exercise(connection, workspace, file, fixture, options, empty_host_settings):
    connection.send({"id": 1, "method": "initialize", "params": {
        "processId": None, "rootUri": workspace.as_uri(),
        "workspaceFolders": [{"uri": workspace.as_uri(), "name": "smoke"}],
        "capabilities": {"workspace": {"configuration": True, "workspaceFolders": True},
            "textDocument": {"publishDiagnostics": {}, "hover": {"contentFormat": ["markdown", "plaintext"]}}},
        "initializationOptions": options}})
    initialize = connection.wait(lambda message: message.get("id") == 1 and "method" not in message)
    if not isinstance(initialize.get("result", {}).get("capabilities"), dict):
        raise ValueError("initialize capabilities missing")
    connection.send({"method": "initialized", "params": {}})
    if not empty_host_settings:
        connection.send({"method": "workspace/didChangeConfiguration", "params": {"settings": {
            "json": {"validate": {"enable": True}}, "yaml": {"validate": True, "schemaStore": {"enable": False}}}}})
    connection.send({"method": "textDocument/didOpen", "params": {"textDocument": {
        "uri": file.as_uri(), "languageId": fixture["language"], "version": 1, "text": fixture["text"]}}})
    expected = fixture["expected"].lower()
    if fixture.get("pull"):
        connection.send({"id": 2, "method": "textDocument/diagnostic", "params": {
            "textDocument": {"uri": file.as_uri()}}})
        response = connection.wait(lambda message: message.get("id") == 2 and "method" not in message)
        result = response.get("result", {}).get("items", [])
        if not result or expected not in json.dumps(result).lower():
            raise ValueError("pulled diagnostics did not match expected content")
    elif fixture["feature"] == "diagnostics":
        response = connection.wait(lambda message: message.get("method") == "textDocument/publishDiagnostics"
            and message.get("params", {}).get("uri") == file.as_uri()
            and bool(message.get("params", {}).get("diagnostics"))
            and expected in json.dumps(message.get("params", {}).get("diagnostics")).lower())
        result = response["params"]["diagnostics"]
    else:
        params = {"textDocument": {"uri": file.as_uri()}}
        if "position" in fixture:
            params["position"] = fixture["position"]
        deadline, request_id = time.monotonic() + 15, 10
        while True:
            request_id += 1
            connection.send({"id": request_id, "method": "textDocument/" + fixture["feature"], "params": params})
            response = connection.wait(lambda message: message.get("id") == request_id and "method" not in message)
            result = response.get("result")
            if result and expected in json.dumps(result).lower():
                break
            if time.monotonic() >= deadline:
                raise ValueError("real language feature did not match expected content: " + json.dumps(result)[:1000])
            time.sleep(.2)
    secondary = {}
    if fixture["language"] == "vue":
        connection.send({"id": 101, "method": "textDocument/hover", "params": {
            "textDocument": {"uri": file.as_uri()}, "position": {"line": 0, "character": 32}}})
        hover = connection.wait(lambda message: message.get("id") == 101 and "method" not in message)
        if "value: string" not in json.dumps(hover.get("result")):
            raise ValueError("Vue bundled TypeScript hover did not preserve source coordinates")
        secondary["hover"] = hover["result"]
        connection.send({"method": "textDocument/didChange", "params": {
            "textDocument": {"uri": file.as_uri(), "version": 2},
            "contentChanges": [{"text": fixture["text"].replace("42", '\"ok\"')}]}})
        cleared = connection.wait(lambda message: message.get("method") == "textDocument/publishDiagnostics"
            and message.get("params", {}).get("uri") == file.as_uri()
            and "2322" not in json.dumps(message.get("params", {}).get("diagnostics")))
        secondary["diagnostics_after_fix"] = cleared["params"]["diagnostics"]
    connection.send({"id": 3, "method": "shutdown"})
    connection.wait(lambda message: message.get("id") == 3 and "method" not in message)
    connection.send({"method": "exit"})
    connection.process.stdin.close()
    return {"initialize": initialize["result"].get("serverInfo"), "feature": fixture["feature"],
            "result": result, "secondary": secondary}


def run(args):
    recipe = json.loads(args.recipe.read_text())
    args.work.mkdir(mode=0o700)
    workspace = args.work / "workspace"
    workspace.mkdir()
    if args.project_dependencies:
        shutil.copytree(args.project_dependencies, workspace / "node_modules", symlinks=False)
    file, fixture = prepare_workspace(recipe["id"], workspace)
    bundle, node = args.bundle.resolve(), args.node.resolve()
    env = {"PATH": str(node.parent) + ":/usr/bin:/bin", "HOME": str(args.work), "TMPDIR": str(args.work),
        "XDG_CACHE_HOME": str(args.work / "cache"), "XDG_CONFIG_HOME": str(args.work / "config"),
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "NO_UPDATE_NOTIFIER": "1"}
    version = subprocess.run([str(node), "--version"], env=env, capture_output=True, check=True, timeout=10)
    if version.stdout.strip() != b"v22.19.0":
        raise ValueError("exact Node22.19.0 validation baseline required")
    evidence = {"schema_version": 1, "id": recipe["id"], "platform": sys.platform + "/" + os.uname().machine,
        "node": "22.19.0", "network": "denied", "credentials": "none", "publication_authority": False,
        "project_dependencies_supplied": bool(args.project_dependencies), "status": "failed"}
    with (args.work / "stderr.log").open("wb") as stderr:
        process = subprocess.Popen(launch_command(node, bundle / recipe["entry"], recipe["args"], args.read_only_root),
            cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
            start_new_session=True)
        configuration = (lambda section: {}) if args.empty_host_settings else settings(recipe["id"], workspace, bundle)
        connection = Connection(process, configuration)
        try:
            options = initialization_options(recipe, bundle, args.empty_host_settings)
            evidence.update(exercise(connection, workspace, file, fixture, options, args.empty_host_settings))
            if process.wait(timeout=10) != 0:
                raise ValueError("server did not exit successfully")
            evidence["status"] = "passed"
        except Exception as error:
            evidence["error"] = type(error).__name__ + ": " + str(error)
            evidence["failure_messages"] = connection.received[-30:]
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
            if not process.stdin.closed:
                process.stdin.close()
            process.stdout.close()
    evidence["server_methods"] = sorted({message["method"] for message in connection.received if "method" in message})
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({key: evidence[key] for key in ("id", "status", "platform")}), flush=True)
    return evidence["status"] == "passed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("recipe", "bundle", "node", "work", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--project-dependencies", type=Path)
    parser.add_argument("--empty-host-settings", action="store_true")
    parser.add_argument("--read-only-root", type=Path, action="append", default=[])
    sys.exit(0 if run(parser.parse_args()) else 1)
