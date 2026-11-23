#!/usr/bin/env python3
"""A scripted agy using the command and ACP shapes of the native CLI."""

import json
import os
import sys
import time
from pathlib import Path

scenario = os.environ.get("AGY_FIXTURE_SCENARIO")
state_path = Path("fixture-session.json")
trace_path = Path("fixture-requests.jsonl")
session_id = "45354c25-4257-428d-87a7-155803f582d1"
child_id = "e10923d9-6452-4233-8a55-20dedfc4595b"
child_call_id = "call_fixture_child"
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


def update(variant, **fields):
    send(method="session/update", params={
        "sessionId": session_id,
        "update": {"sessionUpdate": variant, **fields},
    })


def detached_reply():
    update("agent_thought_chunk", content={"type": "text", "text": "Verify the sources"})
    update("usage_update", used=114, size=1048576)
    for n in range(5):
        update("tool_call", toolCallId=f"read-{n}", name="read_file", title=f"Read source-{n}",
               kind="read", status="in_progress", rawInput={"Path": f"source-{n}.txt"})
        update("tool_call_update", toolCallId=f"read-{n}", status="completed", rawOutput="fixture")
    time.sleep(1.25)
    update("agent_thought_chunk", content={"type": "text", "text": "The sources agree"})
    update("agent_message_chunk", content={"type": "text", "text": "Subagent result"})
    update("usage_update", used=137, size=1048576)
    update("usage_update", used=137, size=1048576)
    update("agent_message_chunk", content={"type": "text", "text": ""})


def child_journal(stage):
    brain = Path.home() / ".gemini/antigravity-cli/brain"
    registry = brain / session_id / ".system_generated/subagents"
    child = brain / child_id / ".system_generated"
    logs = child / "logs"
    transcript = logs / "transcript_full.jsonl"
    if stage == "actions":
        messages = child / "messages"
        for folder in (registry, logs, messages):
            folder.mkdir(parents=True, exist_ok=True)
        launch = {
            "sender": session_id, "recipient": child_id, "sourceMetadata": {"tool": {
                "conversationId": session_id, "stepIndex": 41,
                "toolCall": {"id": child_call_id, "name": "invoke_subagent"},
            }},
        }
        (messages / "9110b22b-7175-43b4-9e1b-0d66f226b6a8.json").write_text(json.dumps(launch))
        with transcript.open("x") as journal:
            journal.write(journal_step(1, "PLANNER_RESPONSE", model="mock-child",
                input_tokens=11, cache_read_tokens=40, output_tokens=3,
                tool_calls=[{"name": "read_file", "args": {"Path": "source.txt"}}]))
            journal.write(journal_step(2, "GENERIC", content="Source notes"))
            journal.write(journal_step(3, "PLANNER_RESPONSE", model="mock-child",
                input_tokens=17, cache_read_tokens=51, output_tokens=4,
                tool_calls=[{"name": "mcp_fixture_tools_count_hits", "args": {"query": "ACP"}}]))
        descriptor = {"conversationId": child_id, "spawnStepIndex": 41,
                      "state": "SUBAGENT_STATE_ALIVE", "subagentDescriptor": {"role": "Researcher"}}
        (registry / f"{child_id}.json").write_text(json.dumps(descriptor))
    elif stage == "finish":
        with transcript.open("a") as journal:
            journal.write(journal_step(4, "GENERIC", content="2 records"))
            journal.write(journal_step(5, "PLANNER_RESPONSE", model="mock-child-v2",
                input_tokens=7, cache_read_tokens=60, output_tokens=8,
                content="Two records match ACP."))
    else:
        raise ValueError(f"unknown child journal stage: {stage}")


def journal_step(step_index, step_type, **fields):
    return json.dumps(dict(step_index=step_index, source="MODEL", type=step_type,
                           status="DONE", **fields)) + "\n"


def mcp_permission():
    tool = {
        "toolCallId": "mcp-call", "title": "Search records", "name": "mcp_fixture_tools_search_records",
        "toolName": "mcp_fixture_tools_search_records", "kind": "other", "status": "pending",
        "rawInput": {"query": "ACP"},
    }
    update("tool_call", **tool)
    send(id="mcp-permission", method="session/request_permission", params={
        "sessionId": session_id, "toolCall": tool, "options": [
            {"optionId": "grant-once", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "grant-always", "name": "Allow always", "kind": "allow_always",
             "_meta": {"agy.security.warning": {"title": "Persistent grant",
                       "message": "Applies to future searches."}}},
        ],
    })


def fixed_choice():
    send(id="choose-target", method="session/request_permission", params={
        "sessionId": session_id,
        "toolCall": {"toolCallId": "interaction_target", "title": "Choose a target", "status": "pending"},
        "options": [
            {"optionId": "staging-id", "name": "Staging", "kind": "allow_once"},
            {"optionId": "preview-id", "name": "Preview", "kind": "allow_once"},
        ],
    })


def run():
    global pending
    expected_choice = None
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
        elif method == "fixture/finish-task":
            update("tool_call_update", toolCallId="task", status="completed")
        elif method == "fixture/wake":
            update("agent_message_chunk", content={"type": "text", "text": "The task returned."})
            update("usage_update", used=185, size=1048576)
        elif method == "session/prompt":
            if scenario == "steer-during-command":
                if pending is None:
                    pending = request_id
                    update("tool_call", toolCallId="task", name="run_command", status="in_progress")
                else:
                    send(id=pending, result={"stopReason": "end_turn"})
                    update("agent_message_chunk", content={"type": "text", "text": "New instruction received."})
                    send(id=request_id, result={"stopReason": "end_turn"})
                continue
            if scenario == "background-wake":
                name = params["prompt"][0]["text"]
                update("tool_call", toolCallId="task", name=name, status="in_progress")
                update("agent_message_chunk", content={"type": "text", "text": "Waiting."})
                send(id=request_id, result={"stopReason": "end_turn"})
                continue
            if scenario == "detached-reply":
                update("agent_message_chunk", content={"type": "text", "text": "Waiting for subagent"})
                update("usage_update", used=101, size=1048576)
                send(id=request_id, result={
                    "stopReason": "end_turn",
                    "usage": {"inputTokens": 90, "outputTokens": 11, "totalTokens": 101},
                })
                detached_reply()
                continue
            if scenario == "child-journal":
                update("tool_call", toolCallId=child_call_id, name="invoke_subagent",
                       title="Research ACP", kind="other", status="in_progress",
                       rawInput={"Role": "Researcher", "Prompt": "Find the ACP records"})
                update("tool_call_update", toolCallId=child_call_id, status="completed")
                send(id=request_id, result={"stopReason": "end_turn"})
                continue
            if scenario == "permissions-and-mcp":
                pending = request_id
                expected_choice = None if params["prompt"][0]["text"] == "Reject a custom choice" else "preview-id"
                mcp_permission()
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
        elif method is None and request_id == "mcp-permission":
            assert msg["result"] == {"outcome": {"outcome": "selected", "optionId": "grant-always"}}, msg
            update("tool_call_update", toolCallId="mcp-call", status="completed",
                   content=[{"type": "content", "content": {"type": "text", "text": "2 records"}}])
            fixed_choice()
        elif method is None and request_id == "choose-target":
            outcome = {"outcome": "cancelled"} if expected_choice is None else {
                "outcome": "selected", "optionId": expected_choice,
            }
            assert msg["result"] == {"outcome": outcome}, msg
            send(id=pending, result={"stopReason": "end_turn"})
        elif method == "session/cancel":
            if pending is not None:
                send(id=pending, result={"stopReason": "cancelled"})
        elif method == "session/close":
            send(id=request_id, result={})
        else:
            send(id=request_id, error={"code": -32601, "message": "Method not found"})


if sys.argv[1:] == ["--version"]:
    print("1.5.14")
elif sys.argv[1:] == ["models"]:
    print("Fetching available models...", file=sys.stderr)
    if scenario == "signed-out":
        print("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.", file=sys.stderr)
        sys.exit(1)
    print("mock-neon-high\tMock Neon (High)")
    print("mock-neon-low\tMock Neon (Low)")
    print("mock-alt-medium\tMock Alt (Medium)")
elif sys.argv[1:] == ["acp"]:
    run()
elif len(sys.argv) == 3 and sys.argv[1] == "fixture-child-journal":
    child_journal(sys.argv[2])
else:
    raise RuntimeError(f"unexpected agy invocation: {sys.argv[1:]}")
