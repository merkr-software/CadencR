#!/usr/bin/env python3
"""Managed conformance fixture that rejects resume while a session is active."""

import json
import os
import sys

SESSION_ID = "managed-resume-session"
MODEL_OPTIONS = [{
    "id": "model",
    "name": "Model",
    "category": "model",
    "type": "select",
    "currentValue": "fixture/default",
    "options": [
        {"value": "fixture/default", "name": "Default"},
        {"value": "fixture/large", "name": "Large"},
    ],
}]


def send(message):
    print(json.dumps(message), flush=True)


def reply(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def reject(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def run(state_path, forbidden_path):
    active = False
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        params = request.get("params") or {}
        request_id = request.get("id")
        if method in ("authenticate", "session/authenticate", "session/prompt"):
            with open(forbidden_path, "w", encoding="utf-8") as marker:
                marker.write(method)
            reject(request_id, -32000, "forbidden conformance method")
            continue
        if method == "initialize":
            reply(request_id, {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": True,
                    "sessionCapabilities": {"resume": {}, "close": {}},
                },
                "agentInfo": {"name": "managed-resume-fixture", "version": "1.2.3"},
            })
        elif method == "session/new":
            active = True
            with open(state_path, "w", encoding="utf-8") as state:
                json.dump({"sessionId": SESSION_ID}, state)
            reply(request_id, {"sessionId": SESSION_ID, "configOptions": MODEL_OPTIONS})
        elif method == "session/set_config_option":
            reply(request_id, {"configOptions": MODEL_OPTIONS})
        elif method == "session/resume":
            if active:
                reject(request_id, -32000, "cannot resume an active session")
            elif params.get("sessionId") != SESSION_ID or not os.path.exists(state_path):
                reject(request_id, -32000, "durable session not found")
            else:
                active = True
                reply(request_id, {"configOptions": MODEL_OPTIONS})
        elif method == "session/load":
            reject(request_id, -32000, "stable resume must take precedence")
        elif method == "session/close":
            active = False
            reply(request_id, {})
        elif method == "session/cancel":
            active = False
        elif request_id is not None:
            reject(request_id, -32601, "method not found")


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else None
    if command == "version":
        print("1.2.3")
        return
    if command == "models":
        print(json.dumps(MODEL_OPTIONS))
        return
    if command == "run":
        state_index = sys.argv.index("--state")
        forbidden_index = sys.argv.index("--forbidden")
        run(sys.argv[state_index + 1], sys.argv[forbidden_index + 1])
        return
    print("unknown command", file=sys.stderr)
    raise SystemExit(2)


if __name__ == "__main__":
    main()
