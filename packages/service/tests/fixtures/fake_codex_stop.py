#!/usr/bin/env python3
"""Codex app-server fixture for Stop, as Codex 0.167 behaves. No model or user files.

A turn whose prompt holds `command` starts a command and keeps running; any
other prompt ends its turn at once. The `turn-start-reply` checkpoint can hold
a `turn/start` reply. After a `broken-interrupt` turn, `turn/interrupt` fails
with an internal error. `turn/interrupt` ends a running turn but leaves
its command running (a background terminal), and is refused once the turn has
ended. Every request is appended to `requests.log` in the working directory.
"""
import json
import pathlib
import runpy
import sys

if "--version" in sys.argv:
    print("codex-cli 0.167.1")
    sys.exit(0)

pause_at = runpy.run_path(str(pathlib.Path(__file__).with_name("provider_gate.py")))["pause_at"]
log = pathlib.Path("requests.log")
root = "root-thread"
running = None
generation = 0
broken_interrupt = False


def emit(value):
    print(json.dumps(value), flush=True)


def notify(method, **params):
    emit({"method": method, "params": params})


def turn(turn_id, status):
    return {"id": turn_id, "status": status, "items": []}


def start_turn(prompt):
    global running, generation
    generation += 1
    turn_id = f"turn-{generation}"
    notify("turn/started", threadId=root, turn=turn(turn_id, "inProgress"))
    notify("item/completed", threadId=root, turnId=turn_id, item={
        "type": "userMessage", "id": f"user-{generation}",
        "content": [{"type": "inputText", "text": prompt}]})
    if "command" in prompt:
        running = turn_id
        notify("item/started", threadId=root, turnId=turn_id, startedAtMs=0, item={
            "type": "commandExecution", "id": f"exec-{generation}",
            "command": "/bin/zsh -lc ./slow-check.sh", "cwd": ".",
            "processId": f"process-{generation}", "status": "inProgress",
            "commandActions": []})
        # Marks that the command started: the stream shows text, not the item.
        notify("item/started", threadId=root, turnId=turn_id,
               item={"type": "agentMessage", "id": f"note-{generation}", "text": ""})
        notify("item/agentMessage/delta", threadId=root, turnId=turn_id,
               itemId=f"note-{generation}", delta="COMMAND_RUNNING")
        return turn_id
    notify("turn/completed", threadId=root, turn=turn(turn_id, "completed"))
    notify("thread/status/changed", threadId=root, status={"type": "idle"})
    return turn_id


def handle(method, params):
    global running
    if method == "initialize":
        return {"userAgent": "codex-cli/0.167.1"}
    if method == "config/read":
        return {"config": {"model": "qa-model", "model_reasoning_effort": "low",
                           "service_tier": None}}
    if method == "model/list":
        return {"data": [{"id": "qa-model", "model": "qa-model", "displayName": "QA model",
                          "isDefault": True, "supportedReasoningEfforts": [],
                          "defaultReasoningEffort": "low"}], "nextCursor": None}
    if method in ("skills/list", "mcpServerStatus/list"):
        return {"data": [], "nextCursor": None}
    if method == "thread/start":
        return {"thread": {"id": root, "turns": []}}
    if method == "turn/interrupt":
        if broken_interrupt:
            return {"code": -32603, "message": "interrupt failed"}
        if running is None or params.get("turnId") != running:
            return {"code": -32600, "message": "no active turn to interrupt"}
        notify("turn/completed", threadId=root, turn=turn(running, "interrupted"))
        running = None
        return {}
    if method == "thread/backgroundTerminals/terminate":
        return {"terminated": True}
    return {}


for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    method, params = msg["method"], msg.get("params", {})
    with log.open("a") as out:
        out.write(json.dumps({"method": method, "params": params}) + "\n")
    if method == "turn/start":
        prompt = " ".join(i.get("text", "") for i in params.get("input", []))
        broken_interrupt = "broken-interrupt" in prompt
        pause_at("turn-start-reply")
        turn_id = f"turn-{generation + 1}"
        emit({"id": msg["id"], "result": {"turn": {"id": turn_id}}})
        start_turn(prompt)
        continue
    result = handle(method, params)
    if isinstance(result, dict) and "code" in result:
        emit({"id": msg["id"], "error": result})
    else:
        emit({"id": msg["id"], "result": result})
