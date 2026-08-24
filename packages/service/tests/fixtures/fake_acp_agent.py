#!/usr/bin/env python3
"""A deterministic ACP v1 agent, used as an installed-provider fixture.

By default this is the code-backed provider admission contract from
`docs/PROVIDER_SPEC/BOUNDARIES.md`: a pre-session `models` command plus
`initialize` at protocol version 1, `session/new`,
`session/prompt` with streaming `session/update` notifications,
`session/cancel`, and a standard JSON-RPC "method not found" for every optional
method it does not implement. It advertises no optional capability, so a test
against it proves the generic path works without any provider-specific help.

Every runtime session advertises the same model selector returned by `models`
and implements `session/set_config_option`, because Cadencr must confirm an
explicit model before the first prompt. `--session-config` remains accepted for
older fixtures and also enables the extra fake boolean option.

`--rich` implies session configuration and emits a representative v1 stream:
commands, plans, usage, shell and edit tools, a permission request, a diff, and
an MCP-shaped tool. The fixture remains provider-neutral — every shape is a
standard ACP v1 message rather than a Cadencr extension.

Behavior is keyed off the prompt text so a test can drive it exactly:

  * a prompt containing "hang" streams one chunk and then waits for a cancel,
    answering `stopReason: "cancelled"`;
  * any other prompt streams every chunk in CHUNKS and answers
    `stopReason: "end_turn"`.

Everything else is fixed: the same session id, the same chunks, in the same
order, with no timing dependence.
"""

import json
import os
import sys
import threading

SESSION_ID = "fake-acp-session-1"
CHUNKS = ["Hello ", "from ", "the ", "fake ", "ACP ", "agent."]

_write_lock = threading.Lock()
_cancelled = threading.Event()
_rich_enabled = "--rich" in sys.argv
_durable_enabled = "--durable" in sys.argv
_extra_session_config_enabled = "--session-config" in sys.argv or _rich_enabled
_safe_mode = False
_model = "fake-small"
_responses = {}
_responses_condition = threading.Condition()
_state_path = None
_memory = ""

if _durable_enabled:
    durable_index = sys.argv.index("--durable")
    if durable_index + 1 >= len(sys.argv):
        print("--durable requires a state path", file=sys.stderr)
        raise SystemExit(2)
    _state_path = sys.argv[durable_index + 1]
def persist_memory():
    if _state_path is None:
        return
    with open(_state_path, "w", encoding="utf-8") as state_file:
        json.dump({"sessionId": SESSION_ID, "memory": _memory}, state_file)


def load_memory():
    global _memory
    with open(_state_path, encoding="utf-8") as state_file:
        state = json.load(state_file)
    if state.get("sessionId") != SESSION_ID:
        raise ValueError("durable session identity mismatch")
    _memory = state.get("memory", "")


def config_options():
    options = []
    if _extra_session_config_enabled:
        options.append({
            "id": "safe_mode",
            "name": "Safe mode",
            "description": "Use conservative behavior",
            "category": "_fake",
            "type": "boolean",
            "currentValue": _safe_mode,
        })
    options.append({
            "id": "model",
            "name": "Model",
            "description": "Model selected by the fake ACP session",
            "category": "model",
            "type": "select",
            "currentValue": _model,
            "options": [
                {"value": "fake-small", "name": "Fake Small"},
                {"value": "fake-large", "name": "Fake Large"},
            ],
        })
    return options


def send(message):
    """Write one newline-delimited JSON-RPC frame."""
    with _write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def reply(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def reply_error(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def stream_chunk(text):
    notify(
        "session/update",
        {
            "sessionId": SESSION_ID,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text},
            },
        },
    )


def session_update(update):
    notify("session/update", {"sessionId": SESSION_ID, "update": update})


def request_permission():
    request_id = "rich-permission-1"
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/request_permission",
            "params": {
                "sessionId": SESSION_ID,
                "toolCall": {
                    "toolCallId": "rich-bash-1",
                    "title": "Bash",
                    "kind": "execute",
                    "rawInput": {"command": "printf rich-acp"},
                },
                "options": [
                    {
                        "optionId": "allow-once",
                        "name": "Allow once",
                        "kind": "allow_once",
                    },
                    {
                        "optionId": "allow-always",
                        "name": "Always allow",
                        "kind": "allow_always",
                    },
                    {
                        "optionId": "deny",
                        "name": "Deny",
                        "kind": "reject_once",
                    },
                ],
            },
        }
    )
    with _responses_condition:
        _responses_condition.wait_for(lambda: request_id in _responses, timeout=10)
        return _responses.pop(request_id, None)


def run_rich_turn(request_id):
    session_update(
        {
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                {"name": "review", "description": "Review the current changes"},
                {"name": "summarize", "description": "Summarize the session"},
            ],
        }
    )
    session_update(
        {
            "sessionUpdate": "plan",
            "entries": [
                {"content": "Inspect the workspace", "status": "completed"},
                {"content": "Apply the change", "status": "in_progress"},
            ],
        }
    )
    session_update(
        {
            "sessionUpdate": "usage_update",
            "used": 321,
            "size": 8192,
            "cost": {"amount": 0.001, "currency": "USD"},
        }
    )
    session_update(
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "rich-bash-1",
            "title": "Run a safe fixture command",
            "kind": "execute",
            "rawInput": {"command": "printf rich-acp"},
        }
    )
    response = request_permission()
    if response is None or response.get("error") is not None:
        reply_error(request_id, -32000, "permission response missing")
        return
    session_update(
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "rich-bash-1",
            "status": "completed",
            "content": [{"type": "text", "text": "rich-acp"}],
        }
    )
    diff = {
        "type": "diff",
        "path": "fixture.txt",
        "oldText": "before\n",
        "newText": "after\n",
    }
    session_update(
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "rich-edit-1",
            "title": "Edit fixture.txt",
            "kind": "edit",
            "content": [diff],
        }
    )
    session_update(
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "rich-edit-1",
            "status": "completed",
            "content": [diff],
        }
    )
    session_update(
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "rich-mcp-1",
            "toolName": "mcp__fixture__lookup",
            "title": "Fixture lookup",
            "kind": "other",
            "rawInput": {"query": "ACP"},
        }
    )
    session_update(
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "rich-mcp-1",
            "status": "completed",
            "content": [{"type": "text", "text": "MCP result"}],
        }
    )
    stream_chunk("Rich ACP turn complete.")
    reply(request_id, {"stopReason": "end_turn"})


def prompt_text(params):
    blocks = params.get("prompt") or []
    return " ".join(
        block.get("text", "") for block in blocks if isinstance(block, dict)
    )


def run_turn(request_id, params):
    """Handle one `session/prompt` off the read loop so cancel can interleave.

    The flag is cleared by the read loop before this thread starts, never here:
    clearing it here would race with — and swallow — a cancel that arrives while
    the thread is still spinning up.
    """
    global _memory
    text = prompt_text(params)
    if _durable_enabled and "remember" in text:
        _memory = "durable-host-memory"
        persist_memory()
    if _durable_enabled and "recall" in text:
        stream_chunk(_memory)
        reply(request_id, {"stopReason": "end_turn"})
        return
    if _rich_enabled and "rich" in text:
        run_rich_turn(request_id)
        return
    if "hang" in text:
        stream_chunk(CHUNKS[0])
        _cancelled.wait()
        reply(request_id, {"stopReason": "cancelled"})
        return
    for chunk in CHUNKS:
        if _cancelled.is_set():
            reply(request_id, {"stopReason": "cancelled"})
            return
        stream_chunk(chunk)
    reply(request_id, {"stopReason": "end_turn"})


def main():
    global _memory, _model, _safe_mode
    turn = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        method = request.get("method")
        params = request.get("params") or {}
        request_id = request.get("id")

        if method is None and request_id is not None:
            with _responses_condition:
                _responses[str(request_id)] = request
                _responses_condition.notify_all()
            continue

        if method == "initialize":
            reply(
                request_id,
                {
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": _durable_enabled},
                    "agentInfo": {"name": "fake-acp-agent", "version": "1.0.0"},
                },
            )
        elif method == "session/new":
            if _durable_enabled:
                _memory = ""
            result = {"sessionId": SESSION_ID}
            result["configOptions"] = config_options()
            reply(request_id, result)
        elif method == "session/load":
            if not _durable_enabled:
                reply_error(request_id, -32601, "method not found: session/load")
            elif params.get("sessionId") != SESSION_ID or not os.path.exists(_state_path):
                reply_error(request_id, -32000, "durable session not found")
            else:
                try:
                    load_memory()
                    reply(request_id, {"configOptions": config_options()})
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    reply_error(request_id, -32000, f"durable session invalid: {error}")
        elif method == "session/set_config_option":
            config_id = params.get("configId")
            value = params.get("value")
            if config_id == "safe_mode" and isinstance(value, bool):
                _safe_mode = value
            elif config_id == "model" and value in ("fake-small", "fake-large"):
                _model = value
            else:
                reply_error(request_id, -32602, "invalid config option")
                continue
            reply(request_id, {"configOptions": config_options()})
        elif method == "session/prompt":
            _cancelled.clear()
            turn = threading.Thread(target=run_turn, args=(request_id, params))
            turn.daemon = True
            turn.start()
        elif method == "session/cancel":
            # A notification: acknowledged by the turn's stop reason, not a reply.
            _cancelled.set()
        elif request_id is not None:
            reply_error(request_id, -32601, "method not found: {}".format(method))

    if turn is not None:
        _cancelled.set()
        turn.join(timeout=1)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else None
    if command == "models":
        print(json.dumps(config_options()))
    elif command == "run":
        main()
    else:
        print("expected provider command `models` or `run`", file=sys.stderr)
        raise SystemExit(2)
