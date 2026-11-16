#!/usr/bin/env python3
"""Deterministic stand-in for the Cursor Agent CLI (`agent`).

Supports `models`, `--version` and `[flags] acp`. Every spawn and every
received ACP frame is appended to $FAKE_AGENT_LOG as JSON lines so tests can
assert what the connector sent to Cursor. Prompts drive scripted behavior:
"ask", "plan", "tools", the plan follow-up, or a plain text echo.
"""

import json
import os
import sys

LOG = os.environ.get("FAKE_AGENT_LOG")
MODELS = {
    "default": [],
    "composer-2.5": ["fast"],
    "gpt-5.3-codex": ["fast", "effort"],
}
STATE = {"mode": "agent", "model": "composer-2.5", "fast": "false", "effort": "medium"}
NEXT_ID = [100]


def log(event, **fields):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(dict(event=event, **fields)) + "\n")


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    message = json.loads(line)
    log("recv", msg=message)
    return message


def select(option_id, name, current, values, category):
    return {
        "id": option_id,
        "name": name,
        "category": category,
        "type": "select",
        "currentValue": current,
        "options": [{"value": value, "name": value} for value in values],
    }


def config_options():
    options = [
        select("mode", "Mode", STATE["mode"], ["agent", "plan", "ask"], "mode"),
        select("model", "Model", STATE["model"], list(MODELS), "model"),
    ]
    companions = MODELS[STATE["model"]]
    if "fast" in companions:
        options.append(select("fast", "Fast", STATE["fast"], ["false", "true"], "model_config"))
    if "effort" in companions:
        options.append(
            select("effort", "Effort", STATE["effort"], ["low", "medium", "high"], "thought_level")
        )
    return options


def update(session_id, body):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": session_id, "update": body}})


def text(session_id, value):
    update(session_id, {"sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": value}})


def request(method, params):
    NEXT_ID[0] += 1
    request_id = NEXT_ID[0]
    send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    while True:
        message = read()
        if message.get("id") == request_id and "method" not in message:
            return message
        handle(message)


def prompt(session_id, prompt_text):
    if prompt_text == "ask":
        reply = request("cursor/ask_question", {
            "toolCallId": "q-1",
            "title": "Pick",
            "questions": [{"id": "q1", "prompt": "Which mode?", "options": [
                {"id": "agent", "label": "Agent"}, {"id": "plan", "label": "Plan"}]}],
        })
        text(session_id, json.dumps(reply.get("result")))
    elif prompt_text == "plan":
        reply = request("cursor/create_plan", {
            "toolCallId": "plan-1",
            "plan": "1. Do it",
            "todos": [{"id": "1", "content": "Do it", "status": "pending"}],
        })
        text(session_id, "plan " + reply["result"]["outcome"]["outcome"])
    elif prompt_text == "tools":
        tools(session_id)
    elif prompt_text == "Plan approved. Proceed with execution.":
        text(session_id, "executing in " + STATE["mode"])
    else:
        text(session_id, "echo " + prompt_text)
    return {"stopReason": "end_turn"}


def tools(session_id):
    update(session_id, {"sessionUpdate": "tool_call", "toolCallId": "sh-1",
                        "title": "`git status`", "kind": "execute", "status": "pending",
                        "rawInput": {"command": "git status"}})
    reply = request("session/request_permission", {
        "sessionId": session_id,
        "toolCall": {"toolCallId": "sh-1", "title": "`git status`", "kind": "execute",
                     "content": [{"type": "content", "content": {
                         "type": "text", "text": "Not in allowlist: git status"}}]},
        "options": [{"optionId": "allow-once", "kind": "allow_once", "name": "Allow"},
                    {"optionId": "reject-once", "kind": "reject_once", "name": "Reject"}],
    })
    text(session_id, "permission " + json.dumps(reply.get("result")))
    update(session_id, {"sessionUpdate": "tool_call", "toolCallId": "w-1", "title": "Write",
                        "toolName": "write_file", "kind": "edit",
                        "rawInput": {"path": "a.txt", "fileText": "hi"}})
    update(session_id, {"sessionUpdate": "tool_call", "toolCallId": "task-1",
                        "title": "Task: Subagent task", "kind": "other",
                        "rawInput": {"_toolName": "task"}})
    update(session_id, {"sessionUpdate": "tool_call_update", "toolCallId": "task-1",
                        "status": "completed", "rawOutput": {"error": "usage limit"}})
    send({"jsonrpc": "2.0", "method": "cursor/task", "params": {
        "toolCallId": "task-1", "description": "Explore", "subagentType": {"custom": "qa"},
        "model": "composer-2.5", "agentId": "agent-7"}})
    update(session_id, {"sessionUpdate": "tool_call", "toolCallId": "task-bg",
                        "title": "Task: Watch CI", "kind": "other",
                        "rawInput": {"_toolName": "task", "description": "Watch CI"}})
    update(session_id, {"sessionUpdate": "tool_call_update", "toolCallId": "task-bg",
                        "status": "completed", "_meta": {"cursor": {"seen": True}},
                        "rawOutput": {"isBackground": True}})
    subagent(session_id)
    request("cursor/update_todos", {"todos": [
        {"id": "1", "content": "Ship", "status": "in_progress"},
        {"id": "2", "content": "Drop", "status": "cancelled"}]})


def subagent(session_id):
    """The background `task-bg` run as Cursor streams it to `subagents` clients."""
    launched = {"cursor": {"toolCallId": "task-bg", "agentId": "child-1"}}
    update(session_id, {"sessionUpdate": "subagent_spawned", "subagentSessionId": "child-1",
                        "name": "generalPurpose", "_meta": launched})
    update("child-1", {"sessionUpdate": "tool_call", "toolCallId": "child-sh",
                       "title": "`sleep 1`", "kind": "execute", "status": "pending",
                       "rawInput": {"command": "sleep 1"}})
    update("child-1", {"sessionUpdate": "plan", "entries": []})
    update("child-1", {"sessionUpdate": "tool_call", "toolCallId": "child-todo",
                       "title": "Update todos", "kind": "other", "status": "completed",
                       "rawInput": {"todos": [{"id": "c1", "content": "Child",
                                               "status": "TODO_STATUS_PENDING"}]}})
    send({"jsonrpc": "2.0", "method": "cursor/update_todos", "params": {
        "sessionId": "child-1", "todos": [{"id": "c1", "content": "Child", "status": "pending"}]}})
    send({"jsonrpc": "2.0", "method": "cursor/generate_image", "params": {
        "sessionId": "child-1", "toolCallId": "child-img", "description": "logo"}})
    text("child-1", "child done")
    update(session_id, {"sessionUpdate": "subagent_state_update", "subagentSessionId": "child-1",
                        "state": "completed", "_meta": launched})


def prompted(session_id):
    """Cursor saves a conversation only once a prompt ran (any agent process)."""
    if not LOG or not os.path.exists(LOG):
        return False
    with open(LOG, encoding="utf-8") as handle:
        for line in handle:
            msg = json.loads(line).get("msg") or {}
            if msg.get("method") == "session/prompt" and \
                    (msg.get("params") or {}).get("sessionId") == session_id:
                return True
    return False


def set_config(params):
    config_id, value = params["configId"], params["value"]
    if config_id == "model":
        STATE["model"] = value
    elif config_id in MODELS[STATE["model"]] or config_id == "mode":
        STATE[config_id] = value
    else:
        return None
    return {"configOptions": config_options()}


def handle(message):
    method = message.get("method")
    params = message.get("params") or {}
    if "id" not in message:
        return
    result, error = None, None
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True},
                  "authMethods": [{"id": "cursor_login", "name": "Cursor"}]}
    elif method == "authenticate":
        result = {}
    elif method == "session/new":
        result = {"sessionId": "sess-1", "configOptions": config_options(),
                  "models": {"currentModelId": STATE["model"], "availableModels": []}}
    elif method == "session/load":
        if prompted(params["sessionId"]):
            text(params["sessionId"], "replayed history")
            result = {"configOptions": config_options()}
        else:
            error = {"code": -32602, "message": "Invalid params",
                     "data": {"message": "Session " + params["sessionId"] + " not found"}}
    elif method == "session/set_config_option":
        result = set_config(params)
        if result is None:
            error = {"code": -32602, "message": "Unknown model config option: " + params["configId"]}
    elif method == "session/set_mode":
        STATE["mode"] = params["modeId"]
        result = {}
    elif method == "session/prompt":
        result = prompt(params["sessionId"], params["prompt"][0]["text"])
    else:
        error = {"code": -32601, "message": "Method not found: " + str(method)}
    reply = {"jsonrpc": "2.0", "id": message["id"]}
    reply["error" if error else "result"] = error or result
    send(reply)
    if method == "session/new" and os.path.exists(os.path.join(params["cwd"], ".fake-live-commands")):
        # What Cursor sends after `session/new`, including the name shapes
        # the connector normalizes (a duplicate, a name with a space).
        update("sess-1", {"sessionUpdate": "available_commands_update", "availableCommands": [
            {"name": "copy-request-id", "description": "Copy the last request ID to clipboard"},
            {"name": "bar", "description": "Command bar (project)"},
            {"name": "Has Space", "description": "Spaced (project)"},
            {"name": "bar", "description": "Skill bar (project skill)"},
            {"name": "loop", "description": "Loop (builtin skill)"},
        ]})


def main():
    args = sys.argv[1:]
    log("spawn", argv=args)
    if args == ["models"]:
        print("Available models:")
        print("auto - Auto")
        print("composer-2.5 - Composer 2.5 (current)")
        print("composer-2.5-fast - Composer 2.5 Fast")
        print("gpt-5.3-codex-high-fast - GPT-5.3 Codex High Fast")
        return
    if args == ["--version"]:
        print("2026.10.22-27dcf5f")
        return
    if not args or args[-1] != "acp":
        sys.stderr.write("unsupported invocation\n")
        sys.exit(2)
    while True:
        handle(read())


if __name__ == "__main__":
    main()
