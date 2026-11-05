#!/usr/bin/env python3
"""Exercise real native language features in credential-free, network-denied workspaces."""
import argparse
import json
import os
from pathlib import Path
import resource
import signal
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lsp-catalog-prepare"))
from node_smoke import Connection
from bounded_output import BoundedOutput, RUNTIME_FILE_LIMIT


FIXTURES = {
    "ruff": {"file": "main.py", "language": "python", "text": "print(undefined_name)\n",
             "feature": "diagnostic", "expected": "F821"},
    "taplo": {"file": "main.toml", "language": "toml", "text": "value = [\n",
              "feature": "push", "expected": "expected"},
    "tsgo": {"file": "main.ts", "language": "typescript", "text": "const value: string = 1;\n",
             "feature": "diagnostic", "expected": "2322"},
    "marksman": {"file": "main.md", "language": "markdown", "text": "# Example\n\n[Target](other.md)\n",
                 "feature": "hover", "position": {"line": 2, "character": 12}, "expected": "Target"},
    "rust-analyzer": {"file": "lib.rs", "language": "rust", "text": "pub fn double(value: i32) -> i32 { value * 2 }\n",
                      "feature": "hover", "position": {"line": 0, "character": 9}, "expected": "fn double"},
    "gopls": {"file": "main.go", "language": "go", "text": "package main\nfunc double(value int) int { return value * 2 }\nfunc main() { _ = double(21) }\n",
              "feature": "hover", "position": {"line": 1, "character": 6}, "expected": "func double"},
    "lua-language-server": {"file": "main.lua", "language": "lua", "text": "local value = 42\nprint(value)\n",
                            "feature": "hover", "position": {"line": 1, "character": 8}, "expected": "integer"},
    "clangd": {"file": "main.cpp", "language": "cpp", "text": "int double_value(int value) { return value * 2; }\n",
               "feature": "hover", "position": {"line": 0, "character": 6}, "expected": "int"},
    "oxlint": {"file": "main.js", "language": "javascript", "text": "debugger;\n",
               "feature": "push", "expected": "debugger"},
    "biome": {"file": "main.js", "language": "javascript", "text": "debugger;\n",
              "feature": "push", "expected": "debugger"},
    "terraform-ls": {"file": "main.tf", "language": "terraform", "text": "variable \"name\" {\n  type = string\n}\n",
                     "feature": "documentSymbol", "expected": "name"},
}


def exercise(connection, workspace, file, fixture, initialization):
    connection.send({"id": 1, "method": "initialize", "params": {
        "processId": None, "rootUri": workspace.as_uri(),
        "workspaceFolders": [{"uri": workspace.as_uri(), "name": "smoke"}],
        "capabilities": {"workspace": {"configuration": True, "workspaceFolders": True,
            "didChangeWatchedFiles": {"dynamicRegistration": True, "relativePatternSupport": True}},
            "textDocument": {"diagnostic": {}, "publishDiagnostics": {},
                             "hover": {"contentFormat": ["markdown", "plaintext"]}}},
        "initializationOptions": initialization}})
    initialized = connection.wait(lambda message: message.get("id") == 1 and "method" not in message)
    connection.send({"method": "initialized", "params": {}})
    connection.send({"method": "workspace/didChangeConfiguration", "params": {"settings": {}}})
    connection.send({"method": "textDocument/didOpen", "params": {"textDocument": {
        "uri": file.as_uri(), "languageId": fixture["language"], "version": 1, "text": fixture["text"]}}})
    if fixture["feature"] == "push":
        result = connection.wait(lambda message: message.get("method") == "textDocument/publishDiagnostics"
            and message.get("params", {}).get("uri") == file.as_uri()
            and fixture["expected"].lower() in json.dumps(message.get("params", {}).get("diagnostics", [])).lower())["params"]
    else:
        params = {"textDocument": {"uri": file.as_uri()}}
        if "position" in fixture:
            params["position"] = fixture["position"]
        for attempt in range(30):
            request_id = 100 + attempt
            connection.send({"id": request_id, "method": "textDocument/" + fixture["feature"], "params": params})
            try:
                result = connection.wait(lambda message: message.get("id") == request_id and "method" not in message)["result"]
            except ValueError as error:
                if "-32801" not in str(error):
                    raise
                time.sleep(.2)
                continue
            if fixture["expected"].lower() in json.dumps(result).lower():
                break
            time.sleep(.2)
        else:
            raise ValueError("semantic result did not match expected content: " + json.dumps(result)[:1000])
    connection.send({"id": 3, "method": "shutdown"})
    connection.wait(lambda message: message.get("id") == 3 and "method" not in message)
    connection.send({"method": "exit"})
    connection.process.stdin.close()
    return {"initialize": initialized["result"].get("serverInfo"), "feature": fixture["feature"], "result": result}


def finish_process(process, evidence):
    observed = process.poll()
    cleanup_returncode = None
    if observed is None:
        try:
            observed = process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                observed = process.wait(timeout=10)
            else:
                cleanup_returncode = process.wait(timeout=10)
    evidence["returncode"] = observed
    evidence["signal"] = None
    if observed is not None and observed < 0:
        try:
            evidence["signal"] = signal.Signals(-observed).name
        except ValueError:
            evidence["signal"] = f"signal {-observed}"
    if cleanup_returncode is not None:
        evidence["cleanup_returncode"] = cleanup_returncode


def runtime_file_limit():
    if sys.platform == "linux":
        _, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        if hard != resource.RLIM_INFINITY and hard < RUNTIME_FILE_LIMIT:
            raise ValueError("native runtime requires a 2 TiB sparse-file hard limit")
        resource.setrlimit(resource.RLIMIT_FSIZE, (RUNTIME_FILE_LIMIT, RUNTIME_FILE_LIMIT))


def run(args):
    recipe = json.loads(args.recipe.read_text())
    fixture = FIXTURES[recipe["id"]]
    entry = (args.bundle / recipe["targets"][args.target]["entry"]).resolve()
    with tempfile.TemporaryDirectory(prefix="ls-", dir="/tmp") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        workspace.mkdir()
        file = workspace / fixture["file"]
        file.write_text(fixture["text"])
        (workspace / ".marksman.toml").write_text("")
        (workspace / "other.md").write_text("# Target\n\nTarget documentation.\n")
        (workspace / "go.mod").write_text("module example.com/smoke\n\ngo 1.26\n")
        (workspace / "tsconfig.json").write_text('{"compilerOptions":{"strict":true},"include":["main.ts"]}')
        (workspace / ".oxlintrc.json").write_text('{"rules":{"no-debugger":"error"}}')
        (workspace / "biome.json").write_text('{"linter":{"enabled":true,"rules":{"recommended":true}}}')
        initialization = recipe["initialization_options"].copy()
        if recipe["id"] == "rust-analyzer":
            initialization["linkedProjects"] = [{"crates": [{"root_module": str(file), "edition": "2021",
                "deps": [], "display_name": "smoke", "cfg": [], "env": {}, "is_workspace_member": True}]}]
        env = {"PATH": ":".join([*args.toolchain_path, "/usr/bin", "/bin"]), "HOME": temporary,
               "TMPDIR": temporary, "XDG_CACHE_HOME": str(root / "cache"), "XDG_CONFIG_HOME": str(root / "config"),
               "CADENCR_LSP_CACHE_ROOT": str(root / "cache" / recipe["id"]),
               "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "GOTOOLCHAIN": "local", "GOPROXY": "off",
               "GOTELEMETRY": "off", "GOCACHE": str(root / "go-cache")}
        command = [str(entry), *recipe["args"]]
        profile = "(version 1)(allow default)(deny network*)(allow network* (local unix-socket))"
        for protected in args.read_only_root:
            profile += "(deny file-write* (subpath " + json.dumps(str(Path(protected).resolve())) + "))"
        if sys.platform == "darwin":
            command = ["/usr/bin/sandbox-exec", "-p", profile, *command]
        elif {name for _, name in socket.if_nameindex()} != {"lo"}:
            raise ValueError("Linux semantic qualification requires denied-network container/namespace")
        evidence = {"id": recipe["id"], "target": args.target, "credentials": "none", "network": "denied", "status": "failed"}
        evidence["process_limits"] = {name: resource.getrlimit(getattr(resource, name)) for name in (
            "RLIMIT_AS", "RLIMIT_FSIZE", "RLIMIT_NPROC", "RLIMIT_NOFILE", "RLIMIT_STACK", "RLIMIT_CORE")}
        if sys.platform == "linux":
            evidence["supervisor_file_limit"] = evidence["process_limits"]["RLIMIT_FSIZE"]
            evidence["process_limits"]["RLIMIT_FSIZE"] = [RUNTIME_FILE_LIMIT, RUNTIME_FILE_LIMIT]
        evidence["cpu_count"] = os.cpu_count()
        process = subprocess.Popen(command, cwd=workspace, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, bufsize=0,
            preexec_fn=runtime_file_limit)
        stderr = BoundedOutput(process, process.stderr)
        try:
            def configuration(section):
                if recipe["id"] == "taplo":
                    return {"schema": {"enabled": False, "catalogs": []}}
                return {}
            connection = Connection(process, configuration)
            try:
                evidence.update(exercise(connection, workspace, file, fixture, initialization))
                if process.wait(timeout=10):
                    raise ValueError("nonzero server exit")
                evidence["status"] = "passed"
            except Exception as error:
                evidence["error"] = type(error).__name__ + ": " + str(error)
            finally:
                finish_process(process, evidence)
                process.stdin.close()
                process.stdout.close()
                if recipe.get("cleanup_args"):
                    cleanup = [str(entry), *recipe["cleanup_args"]]
                    if sys.platform == "darwin":
                        cleanup = ["/usr/bin/sandbox-exec", "-p", profile, *cleanup]
                    subprocess.run(cleanup, cwd=workspace, env=env,
                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True)
        finally:
            try:
                stderr.finish()
            except ValueError as error:
                evidence.update(status="failed", error=str(error))
        evidence["messages"] = connection.received[-12:]
        evidence["stderr"] = stderr.tail.decode(errors="replace")
        evidence["stderr_bytes"] = stderr.total
        evidence["stderr_budget_exceeded"] = stderr.exceeded
        args.output.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({key: evidence[key] for key in ("id", "target", "status")}), flush=True)
        return evidence["status"] == "passed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("recipe", "bundle", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--toolchain-path", action="append", default=[])
    parser.add_argument("--read-only-root", action="append", default=[])
    sys.exit(0 if run(parser.parse_args()) else 1)
