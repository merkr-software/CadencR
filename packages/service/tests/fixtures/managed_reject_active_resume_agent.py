#!/usr/bin/env python3
"""Managed conformance fixture for model selection and fresh-process restore."""

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


def reject(request_id, code, message, data=None):
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    send({"jsonrpc": "2.0", "id": request_id, "error": error})


def options(current):
    result = json.loads(json.dumps(MODEL_OPTIONS))
    result[0]["currentValue"] = current
    if "--changed-live-catalog" in sys.argv:
        result[0]["options"].append({"value": "fixture/new", "name": "New"})
    return result


def run(state_path, forbidden_path):
    active = False
    current = "fixture/large" if "--different-initial-model" in sys.argv else "fixture/default"
    if "--invalid-live-model" in sys.argv:
        current = "unknown"
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        params = request.get("params") or {}
        request_id = request.get("id")
        with open(state_path + ".calls", "a", encoding="utf-8") as calls:
            calls.write(json.dumps({"method": method, "params": params}) + "\n")
        if method in ("authenticate", "session/authenticate", "session/prompt"):
            with open(forbidden_path, "w", encoding="utf-8") as marker:
                marker.write(method)
            reject(request_id, -32000, "forbidden conformance method")
            continue
        if method == "initialize":
            session_capabilities = {"close": {}}
            if "--load-only" not in sys.argv:
                session_capabilities["resume"] = {}
            reply(request_id, {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": True,
                    "sessionCapabilities": session_capabilities,
                },
                "agentInfo": {"name": "managed-resume-fixture", "version": "1.2.3"},
            })
        elif method == "session/new":
            active = True
            if "--empty-not-retained" not in sys.argv:
                with open(state_path, "w", encoding="utf-8") as state:
                    json.dump({"sessionId": SESSION_ID}, state)
            reply(request_id, {"sessionId": SESSION_ID, "configOptions": options(current)})
        elif method == "session/set_config_option":
            if "--ignore-model-selection" not in sys.argv:
                current = params.get("value")
            reply(request_id, {"configOptions": options(current)})
        elif method in ("session/resume", "session/load"):
            if method == "session/load" and "--load-only" not in sys.argv:
                reject(request_id, -32000, "stable resume must take precedence")
                continue
            if active:
                reject(request_id, -32000, "cannot resume an active session")
            elif "--restore-method-missing" in sys.argv:
                reject(request_id, -32601, "method not found")
            elif "--empty-not-retained" in sys.argv or "--other-session-missing" in sys.argv:
                missing = "another-session" if "--other-session-missing" in sys.argv else SESSION_ID
                reject(request_id, -32602, "Invalid params",
                       {"message": f'Session "{missing}" not found'})
            elif params.get("sessionId") != SESSION_ID or not os.path.exists(state_path):
                reject(request_id, -32000, "durable session not found")
            else:
                active = True
                restored = "fixture/large" if "--restore-wrong-model" in sys.argv else "fixture/default"
                reply(request_id, {"configOptions": options(restored)})
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
