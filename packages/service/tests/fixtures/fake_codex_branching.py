#!/usr/bin/env python3
"""Codex app-server fixture for forks and rewinds. No model or user files.

The working directory's `fixture-mode` file picks the app-server it plays:
- `revert`: Codex 0.167+, which cuts with thread/revert and answers
  thread/rollback like any unknown method;
- `rollback`: an older app-server, which only knows thread/rollback;
- `ignore-cut`: accepts thread/revert but keeps the whole history.
Every request method is appended to `requests.log` in the same directory.
"""
import json
import pathlib
import sys

if "--version" in sys.argv:
    print("codex-cli 0.167.1")
    sys.exit(0)

mode = pathlib.Path("fixture-mode").read_text().strip()
log = pathlib.Path("requests.log")
threads = {"source-thread": [f"turn-{n}" for n in range(3)]}


def unknown(method):
    # Codex lists every method it knows after the unknown one.
    return {"code": -32600, "message": f"Invalid request: unknown variant `{method}`, "
            "expected one of `initialize`, `thread/fork`, `account/rateLimits/read`"}


def thread(thread_id):
    return {"id": thread_id, "turns": [
        {"id": turn, "items": [{"type": "userMessage", "id": turn + "-user"}]}
        for turn in threads[thread_id]]}


def handle(method, params):
    if method == "initialize":
        return {"userAgent": "codex-cli/0.167.1"}, None
    if method == "thread/read":
        return {"thread": thread(params["threadId"])}, None
    if method == "thread/fork":
        fork = f"fork-{len(threads)}"
        threads[fork] = list(threads[params["threadId"]])
        return {"thread": thread(fork)}, None
    if method == "thread/revert":
        if mode == "rollback":
            return None, unknown(method)
        turns = threads[params["threadId"]]
        if mode != "ignore-cut":
            del turns[turns.index(params["beforeTurnId"]):]
        return {"thread": {"id": params["threadId"], "turns": []}}, None
    if method == "thread/rollback":
        if mode != "rollback":
            return None, unknown(method)
        del threads[params["threadId"]][-params["numTurns"]:]
        return {}, None
    return {}, None


for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    with log.open("a") as out:
        out.write(json.dumps({"method": msg["method"], "params": msg.get("params", {})}) + "\n")
    result, error = handle(msg["method"], msg.get("params", {}))
    reply = {"id": msg["id"], "error": error} if error else {"id": msg["id"], "result": result}
    print(json.dumps(reply), flush=True)
