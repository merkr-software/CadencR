#!/usr/bin/env python3
"""A deterministic ACP v1 agent, used as an installed-provider fixture.

By default this is the code-backed provider admission contract from
`docs/PROVIDER_SPEC/BOUNDARIES.md`: a pre-session `models` command plus
`initialize` at protocol version 1, `session/new`,
`session/prompt` with streaming `session/update` notifications,
`session/cancel`, and a standard JSON-RPC "method not found" for every optional
method it does not implement. It advertises only stable `session/close` by
default, so a test against it proves the generic path works without any
provider-specific help.

Every runtime session advertises the same model selector returned by `models`
and implements `session/set_config_option`, because Cadencr must confirm an
explicit model before the first prompt. `--session-config` remains accepted for
older fixtures and also enables the extra fake boolean option.

`--rich` implies session configuration and emits a representative v1 stream:
commands, plans, usage, shell and edit tools, a permission request, a diff, and
an MCP-shaped tool. A prompt containing "gate" instead raises the host's
input-collecting gates: an `AskUserQuestion` and an `ExitPlanMode` permission
request, echoing each answer (option id, `_meta.feedback`,
`_meta.updatedInput`) back as text. The fixture remains provider-neutral —
every shape is a standard ACP v1 message rather than a Cadencr extension.

`--host` adds the optional host conventions from
`docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md` and `INSTALLED_ACP_PROVIDERS.md`: a
mode selector and an access-mode selector mapped through `_meta.cadencr`, a
valid `host-integration` declaration, `promptCapabilities.embeddedContext`,
agent-initiated mode switches, a `/compress` compaction command, embedded
resource echoes and background sub-agents. `--host-integration-invalid` makes
`host-integration` print a declaration the host must reject. Without either
flag `host-integration` exits non-zero, like a package built before it existed.

`slash-commands` follows the same pattern. `--slash-commands` lists `review`,
a `deploy` skill and one command per line of `<cwd>/.fake-commands` (each run
appends a line to `<cwd>/.fake-slash-runs`, and the process cwd must equal
`--cwd`); `--slash-commands-invalid` prints a list the host must reject;
`--slash-commands-failing` reports a failure as `{"message"}`. Without them
the command exits non-zero. `--live-commands` sends an
`available_commands_update` right after `session/new`, including a
`server-only` command no listing knows.

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
_host_enabled = "--host" in sys.argv
_extra_session_config_enabled = "--session-config" in sys.argv or _rich_enabled
_safe_mode = False
_model = "fake-small"
_mode = "agent"
_sandbox = "on"
HOST_MODES = [("agent", "Agent", "default"), ("plan", "Plan", "plan"), ("ask", "Ask", "ask")]
HOST_ACCESS = [("on", "Sandboxed", "default"), ("off", "Full access", "fullAccess")]
HOST_INTEGRATION = {
    "compactCommand": "compress",
    "worktreeConfigPaths": [".fake/rules"],
    "resumeCommand": {"program": "fake-agent", "args": ["--resume", "{session_id}"]},
}
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


def host_options():
    """The mode and access selectors, values mapped onto host modes."""
    return [
        {
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": _mode,
            "options": [
                {"value": value, "name": name, "description": name + " mode",
                 "_meta": {"cadencr": {"permissionMode": host}}}
                for value, name, host in HOST_MODES
            ] + [{"value": "debug", "name": "Debug (unmapped)"}],
        },
        {
            "id": "sandbox",
            "name": "Sandbox",
            "type": "select",
            "currentValue": _sandbox,
            "_meta": {"cadencr": {"role": "access_mode"}},
            "options": [
                {"value": value, "name": name, "_meta": {"cadencr": {"accessMode": host}}}
                for value, name, host in HOST_ACCESS
            ],
        },
    ]


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
    if _host_enabled:
        options.extend(host_options())
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


LIVE_COMMANDS = [
    {"name": "review", "description": "Review the current changes"},
    {"name": "deploy", "description": "Deploy", "_meta": {"cadencr": {"kind": "skill"}}},
    {"name": "server-only", "description": "Only the live session knows this one"},
]


def listed_slash_commands():
    cwd = sys.argv[sys.argv.index("--cwd") + 1]
    if os.path.realpath(os.getcwd()) != os.path.realpath(cwd):
        print(json.dumps({"message": "slash-commands ran outside --cwd"}))
        raise SystemExit(1)
    with open(os.path.join(cwd, ".fake-slash-runs"), "a") as runs:
        runs.write("run\n")
    commands = [
        {"name": "review", "description": "Review the current changes"},
        {"name": "deploy", "description": "Deploy", "kind": "skill"},
    ]
    extra = os.path.join(cwd, ".fake-commands")
    if os.path.exists(extra):
        with open(extra) as lines:
            commands.extend({"name": line.strip()} for line in lines if line.strip())
    return commands


RICH_BASH_OPTIONS = [
    {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
    {"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
    {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
]

# Input-collecting gates (`AskUserQuestion`, `ExitPlanMode`) offer one allow and
# one reject option; Cadencr answers with the matching option id and returns
# the user's input under `_meta.updatedInput` (feedback under `_meta.feedback`).
GATE_OPTIONS = [
    {"optionId": "gate-accept", "name": "Accept", "kind": "allow_once"},
    {"optionId": "gate-reject", "name": "Reject", "kind": "reject_once"},
]


def request_permission(request_id, tool_call, options):
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/request_permission",
            "params": {
                "sessionId": SESSION_ID,
                "toolCall": tool_call,
                "options": options,
            },
        }
    )
    with _responses_condition:
        _responses_condition.wait_for(lambda: request_id in _responses, timeout=10)
        return _responses.pop(request_id, None)


def gate_answer(response):
    """Summarize a gate response as `optionId|feedback|updatedInput`."""
    result = (response or {}).get("result") or {}
    meta = result.get("_meta") or {}
    selected = (result.get("outcome") or {}).get("optionId")
    updated = json.dumps(meta.get("updatedInput"), sort_keys=True)
    return "{}|{}|{}".format(selected, meta.get("feedback"), updated)


def run_gate_turn(request_id):
    """Raise an `AskUserQuestion` gate, then an `ExitPlanMode` plan gate."""
    question_input = {
        "questions": [
            {
                "question": "Color?",
                "header": "Color",
                "multiSelect": False,
                "options": [{"label": "Blue"}, {"label": "Red"}],
            }
        ]
    }
    question = {
        "toolCallId": "gate-question-1",
        "title": "Ask the user",
        "name": "AskUserQuestion",
        "kind": "other",
        "rawInput": question_input,
    }
    session_update(dict(question, sessionUpdate="tool_call"))
    answer = request_permission("gate-question-1", question, GATE_OPTIONS)
    session_update(
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "gate-question-1",
            "status": "completed",
        }
    )
    stream_chunk("question=" + gate_answer(answer) + "\n")
    plan = {
        "toolCallId": "gate-plan-1",
        "title": "Ready to code?",
        "name": "ExitPlanMode",
        "kind": "switch_mode",
        "rawInput": {"plan": "1. Paint it blue"},
    }
    session_update(dict(plan, sessionUpdate="tool_call"))
    verdict = request_permission("gate-plan-1", plan, GATE_OPTIONS)
    session_update(
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "gate-plan-1",
            "status": "completed",
        }
    )
    stream_chunk("plan=" + gate_answer(verdict))
    reply(request_id, {"stopReason": "end_turn"})


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
    response = request_permission(
        "rich-permission-1",
        {
            "toolCallId": "rich-bash-1",
            "title": "Bash",
            "kind": "execute",
            "rawInput": {"command": "printf rich-acp"},
        },
        RICH_BASH_OPTIONS,
    )
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


def run_background_turn(request_id):
    """Two background sub-agents: one declared at launch, one only on the
    completed update. The first finishes after the turn ended; the second
    never reports back, like an agent that cannot."""
    session_update({
        "sessionUpdate": "tool_call",
        "toolCallId": "bg-launch",
        "name": "Agent",
        "title": "Explore in the background",
        "kind": "other",
        "rawInput": {"description": "Explore", "prompt": "Map the repo", "subagent_type": "explore"},
        "_meta": {"cadencr": {"subagent": {"background": True}}},
    })
    session_update({"sessionUpdate": "tool_call_update", "toolCallId": "bg-launch", "status": "completed"})
    session_update({
        "sessionUpdate": "tool_call",
        "toolCallId": "bg-late",
        "name": "Agent",
        "title": "Review in the background",
        "kind": "other",
        "rawInput": {"description": "Review", "prompt": "Review it", "subagent_type": "review"},
    })
    session_update({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "bg-late",
        "status": "completed",
        "rawOutput": {"isBackground": True},
        "_meta": {"cadencr": {"subagent": {"background": True}}},
    })
    stream_chunk("Background agents launched.")
    reply(request_id, {"stopReason": "end_turn"})

    def finish_later():
        threading.Event().wait(0.5)
        session_update({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "bg-launch",
            "status": "completed",
            "_meta": {"cadencr": {"subagent": {"status": "completed", "summary": "Mapped the repo"}}},
        })

    finisher = threading.Thread(target=finish_later)
    finisher.daemon = True
    finisher.start()


def run_host_turn(request_id, params, text):
    """Host-convention prompts; returns False when the prompt is not one."""
    global _mode
    resources = [
        block.get("resource") or {}
        for block in params.get("prompt") or []
        if isinstance(block, dict) and block.get("type") == "resource"
    ]
    if resources:
        stream_chunk("resource=" + ",".join(r.get("mimeType", "") for r in resources))
    elif text.strip() == "/compress":
        stream_chunk("compacted")
    elif "state" in text:
        stream_chunk("mode={} access={} pid={}".format(_mode, _sandbox, os.getpid()))
    elif text.startswith("switch to "):
        _mode = text[len("switch to "):].strip()
        session_update({"sessionUpdate": "config_option_update", "configOptions": config_options()})
        stream_chunk("switched")
    elif "background" in text:
        run_background_turn(request_id)
        return True
    else:
        return False
    reply(request_id, {"stopReason": "end_turn"})
    return True


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
    if _host_enabled and run_host_turn(request_id, params, text):
        return
    if _rich_enabled and "rich" in text:
        run_rich_turn(request_id)
        return
    if _rich_enabled and "gate" in text:
        run_gate_turn(request_id)
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
    global _memory, _model, _mode, _safe_mode, _sandbox
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
            session_capabilities = {"close": {}}
            if _durable_enabled:
                session_capabilities["resume"] = {}
            reply(
                request_id,
                {
                    "protocolVersion": 1,
                    # Keep loadSession for compatibility coverage while the
                    # host proves stable session/resume wins when both exist.
                    "agentCapabilities": {
                        "loadSession": _durable_enabled,
                        "sessionCapabilities": session_capabilities,
                        "promptCapabilities": {"embeddedContext": _host_enabled},
                    },
                    "agentInfo": {"name": "fake-acp-agent", "version": "1.0.0"},
                },
            )
        elif method == "session/new":
            if _durable_enabled:
                _memory = ""
            result = {"sessionId": SESSION_ID}
            result["configOptions"] = config_options()
            reply(request_id, result)
            if "--live-commands" in sys.argv:
                session_update(
                    {"sessionUpdate": "available_commands_update", "availableCommands": LIVE_COMMANDS}
                )
        elif method in ("session/resume", "session/load"):
            if not _durable_enabled:
                reply_error(request_id, -32601, f"method not found: {method}")
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
            elif _host_enabled and config_id == "mode" and value in [m[0] for m in HOST_MODES]:
                _mode = value
            elif _host_enabled and config_id == "sandbox" and value in [a[0] for a in HOST_ACCESS]:
                _sandbox = value
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
        elif method == "session/close":
            _cancelled.set()
            reply(request_id, {})
        elif request_id is not None:
            reply_error(request_id, -32601, "method not found: {}".format(method))

    if turn is not None:
        _cancelled.set()
        turn.join(timeout=1)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else None
    if command == "models":
        print(json.dumps(config_options()))
    elif command == "host-integration" and _host_enabled:
        print(json.dumps(HOST_INTEGRATION))
    elif command == "host-integration" and "--host-integration-invalid" in sys.argv:
        print(json.dumps({"compactCommand": "/not a command"}))
    elif command == "slash-commands" and "--slash-commands" in sys.argv:
        print(json.dumps(listed_slash_commands()))
    elif command == "slash-commands" and "--slash-commands-invalid" in sys.argv:
        print(json.dumps([{"name": "/not a command"}]))
    elif command == "slash-commands" and "--slash-commands-failing" in sys.argv:
        print(json.dumps({"message": "fake command directory is unreadable"}))
        raise SystemExit(1)
    elif command == "run":
        main()
    else:
        print("expected provider command `models` or `run`", file=sys.stderr)
        raise SystemExit(2)
