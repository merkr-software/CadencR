#!/usr/bin/env python3
"""A scripted agy using the command and ACP shapes of the native CLI."""

import json
import os
import sys
from pathlib import Path

scenario = os.environ.get("AGY_FIXTURE_SCENARIO")
state_path = Path("fixture-session.json")
trace_path = Path("fixture-requests.jsonl")
session_id = "45354c25-4257-428d-87a7-155803f582d1"
pending = None


def send(**frame):
    print(json.dumps(dict(jsonrpc="2.0", **frame)), flush=True)


def options(state):
    model = state["model"]
    result = [{
        "id": "model", "name": "Model", "category": "model", "type": "select",
        "currentValue": model, "options": [
            {"value": "mock-neon", "name": "Mock Neon"},
            {"value": "mock-alt-medium", "name": "Mock Alt (Medium)"},
        ],
    }]
    if model == "mock-neon":
        result.append({
            "id": "thought_level", "name": "Thinking Level",
            "category": "thought_level", "type": "select",
            "currentValue": state["thought_level"],
            "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}],
        })
    modes = [
        {"value": "default", "name": "Default"},
        {"value": "accept-edits", "name": "Accept edits"},
    ]
    if scenario != "no-auto-mode":
        modes.append({"value": "auto", "name": "Auto", "_meta": {"antigravity": {"fixture": True}}})
    modes.append({"value": "plan", "name": "Plan"})
    result.append({
        "id": "mode", "name": "Mode", "category": "mode", "type": "select",
        "currentValue": state["mode"], "options": modes,
    })
    return result


def read_state():
    return json.loads(state_path.read_text())


def save_state(state):
    state_path.write_text(json.dumps(state))


def update(kind, **fields):
    send(method="session/update", params={
        "sessionId": session_id,
        "update": {"sessionUpdate": kind, **fields},
    })


def run():
    global pending
    for line in sys.stdin:
        msg = json.loads(line)
        method = msg.get("method")
        request_id = msg.get("id")
        params = msg.get("params", {})
        with trace_path.open("a") as log:
            log.write(json.dumps(msg) + "\n")

        if method == "initialize":
            if scenario == "native-exit":
                sys.exit(7)
            if scenario == "malformed":
                print("not a JSON-RPC frame", flush=True)
                continue
            send(id=request_id, result={
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": True, "load_session": True,
                    "promptCapabilities": {"image": True, "embeddedContext": True},
                    "sessionCapabilities": {"resume": {}, "close": {}, "list": {}},
                    "_meta": {"antigravity": {"systemPrompt": {"append": True}}},
                },
                "agentInfo": {"name": "Antigravity ACP Server", "version": "1.5.14"},
                "authMethods": [{"id": "oauth-personal", "name": "Log in with Google"}],
            })
        elif method == "session/new":
            if scenario == "signed-out":
                send(id=request_id, error={
                    "code": -32000, "message": "Authentication required", "data": {"fixture": True},
                })
                continue
            state = {"model": "mock-alt-medium", "thought_level": "high", "mode": "default"}
            save_state(state)
            send(id=request_id, result={"sessionId": session_id, "configOptions": options(state)})
            update("available_commands_update", availableCommands=[{"name": "compact"}])
        elif method in ("session/load", "session/resume"):
            if params.get("sessionId") != session_id or not state_path.exists():
                send(id=request_id, error={"code": -32602, "message": "Unknown session"})
                continue
            send(id=request_id, result={"sessionId": session_id, "configOptions": options(read_state())})
        elif method == "session/set_config_option":
            state = read_state()
            option = next((opt for opt in options(state) if opt["id"] == params["configId"]), None)
            if not option or params["value"] not in [entry["value"] for entry in option["options"]]:
                send(id=request_id, error={"code": -32602, "message": "Value unavailable"})
                continue
            state[params["configId"]] = params["value"]
            save_state(state)
            updated = options(state)
            update("config_option_update", configOptions=updated)
            send(id=request_id, result={"configOptions": updated})
        elif method == "session/prompt":
            if scenario == "detached-reply":
                update("agent_message_chunk", content={"type": "text", "text": "Waiting for subagent"})
                update("usage_update", used=101, size=1048576)
                send(id=request_id, result={
                    "stopReason": "end_turn",
                    "usage": {"inputTokens": 90, "outputTokens": 11, "totalTokens": 101},
                })
                update("agent_message_chunk", content={"type": "text", "text": "Subagent result"})
                update("usage_update", used=137, size=1048576)
                update("usage_update", used=137, size=1048576)
                continue
            pending = request_id
            update("agent_message_chunk", content={"type": "text", "text": "Fixture reply"})
            tool = {
                "toolCallId": "approval-tool", "title": "printf fixture", "name": "run_command",
                "kind": "execute", "status": "pending",
                "rawInput": {"CommandLine": "printf fixture"},
            }
            send(id="approval-1", method="session/request_permission", params={
                "sessionId": session_id, "toolCall": tool, "options": [
                    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
                ],
            })
        elif method is None and request_id == "approval-1":
            result = msg["result"]
            assert result["outcome"]["optionId"] == "deny"
            send(id=pending, result={"stopReason": "end_turn"})
        elif method == "session/cancel":
            send(id=pending, result={"stopReason": "cancelled"})
        elif method == "session/close":
            send(id=request_id, result={})
        else:
            send(id=request_id, error={"code": -32601, "message": "Method not found"})


if sys.argv[1:] == ["models"]:
    print("Fetching available models...", file=sys.stderr)
    if scenario == "signed-out":
        print("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.", file=sys.stderr)
        sys.exit(1)
    print("mock-neon-high\tMock Neon (High)")
    print("mock-neon-low\tMock Neon (Low)")
    print("mock-alt-medium\tMock Alt (Medium)")
elif sys.argv[1:] == ["acp"]:
    run()
else:
    raise RuntimeError(f"unexpected agy invocation: {sys.argv[1:]}")
