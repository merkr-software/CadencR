#!/usr/bin/env python3
"""Credential-free LSP initialize/shutdown smoke against an already reviewed entry."""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


def reader(stream, messages):
    try:
        while True:
            headers = {}
            while line := stream.readline():
                if line in (b"\r\n", b"\n"):
                    break
                key, value = line.decode("ascii").split(":", 1)
                headers[key.lower()] = value.strip()
            if not line:
                messages.put(ValueError("server stdout ended"))
                return
            length = int(headers["content-length"])
            if not 0 < length <= 8 * 1024 * 1024:
                raise ValueError("invalid response length")
            body = bytearray()
            while len(body) < length:
                chunk = stream.read(length - len(body))
                if not chunk:
                    raise ValueError("truncated LSP message")
                body.extend(chunk)
            messages.put(json.loads(body))
    except Exception as error:
        messages.put(error)


def send(process, message):
    body = json.dumps({"jsonrpc": "2.0", **message}).encode()
    process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    process.stdin.flush()


def response(process, messages, request_id, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        message = messages.get(timeout=max(.01, deadline - time.monotonic()))
        if isinstance(message, Exception):
            raise message
        if message.get("id") == request_id and "method" not in message:
            if "error" in message:
                raise ValueError(f"LSP error: {message['error']}")
            return message["result"]
        if "id" in message and "method" in message:
            result = [] if message["method"] == "workspace/configuration" else None
            send(process, {"id": message["id"], "result": result})
    raise TimeoutError("LSP response timed out")


def smoke(entry, args, timeout, cleanup_args=None):
    with tempfile.TemporaryDirectory(prefix="ls-", dir="/tmp") as directory:
        home = Path(directory)
        env = {"PATH": "/usr/bin:/bin", "HOME": directory, "TMPDIR": directory,
               "XDG_CACHE_HOME": str(home / "cache"), "XDG_CONFIG_HOME": str(home / "config"),
               "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
        with (home / "stderr.log").open("wb") as stderr:
            process = subprocess.Popen([str(entry.resolve()), *args], cwd=directory, env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, bufsize=0)
            messages = queue.Queue()
            thread = threading.Thread(target=reader, args=(process.stdout, messages), daemon=True)
            thread.start()
            try:
                send(process, {"id": 1, "method": "initialize", "params": {
                    "processId": os.getpid(), "rootUri": home.as_uri(),
                    "capabilities": {}, "workspaceFolders": [], "initializationOptions": {}}})
                result = response(process, messages, 1, timeout)
                if not isinstance(result.get("capabilities"), dict):
                    raise ValueError("initialize omitted capabilities")
                send(process, {"method": "initialized", "params": {}})
                send(process, {"id": 2, "method": "shutdown"})
                response(process, messages, 2, timeout)
                send(process, {"method": "exit"})
                process.stdin.close()
                code = process.wait(timeout=timeout)
                if code:
                    raise ValueError(f"server exited {code}")
                return {"ok": True, "server_info": result.get("serverInfo"),
                        "capabilities": sorted(result["capabilities"]), "exit_code": code}
            except Exception as error:
                process.kill()
                process.wait()
                stderr.flush()
                raise RuntimeError(f"{error}; stderr: {(home / 'stderr.log').read_text(errors='replace')[:4000]}") from error
            finally:
                process.stdin.close()
                process.stdout.close()
                if cleanup_args:
                    subprocess.run([str(entry.resolve()), *cleanup_args], cwd=directory, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=timeout, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", type=Path, required=True)
    parser.add_argument("--args-json", default="[]")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--cleanup-args-json", default="null")
    args = parser.parse_args()
    print(json.dumps(smoke(args.entry, json.loads(args.args_json), args.timeout, json.loads(args.cleanup_args_json))))


if __name__ == "__main__":
    main()
