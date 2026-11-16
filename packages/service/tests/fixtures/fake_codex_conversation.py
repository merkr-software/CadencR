#!/usr/bin/env python3
"""Deterministic Codex app-server fixture. No model, tool execution or user files."""
import json
import sys
import threading
import time
import uuid

if "--version" in sys.argv:
    print("codex-cli 0.154.0")
    sys.exit(0)

lock = threading.Lock()
root = str(uuid.uuid4())
threads = {}
started_messages = set()
servers = []
generation = 0
mode = ""


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def notify(method, **params):
    emit({"method": method, "params": params})


def boundary(thread, action):
    notify("turn/" + action, threadId=thread, turn={
        "id": thread + "-turn-" + str(generation),
        "status": "completed" if action == "completed" else "inProgress", "items": []})


def text(thread, value, suffix):
    item_id = f"{thread}-message-{generation}-{suffix}"
    if item_id not in started_messages:
        started_messages.add(item_id)
        notify("item/started", threadId=thread,
               item={"type": "agentMessage", "id": item_id, "text": ""})
    notify("item/agentMessage/delta", threadId=thread,
           itemId=item_id, delta=value)


def activity(sender, target, kind, call):
    item = {"id": call, "type": "subAgentActivity", "kind": kind,
            "agentThreadId": target, "agentPath": "/root" if target == root else "/root/child"}
    for action in ("started", "completed"):
        notify("item/" + action, threadId=sender, item=item)


def child_metadata(thread, parent):
    return {"id": thread, "status": {"type": "active", "activeFlags": []},
            "source": {"subAgent": {"thread_spawn": {"parent_thread_id": parent,
                                                       "agent_path": "/root/child"}}}}


def read_tool(suffix):
    notify("item/completed", threadId=root, item={"type": "dynamicToolCall",
           "id": f"read-{generation}-{suffix}", "tool": "Read", "arguments": {"path": "fixture.txt"},
           "contentItems": [{"type": "inputText", "text": "fixture"}], "success": True})


def scenario(current_mode):
    boundary(root, "started")
    notify("item/completed", threadId=root, item={"type": "userMessage",
           "id": f"user-{generation}", "content": [{"type": "inputText", "text": current_mode}]})
    child = root + "-child"
    if current_mode in ("upward", "sibling"):
        threads[child] = child_metadata(child, root)
        activity(root, child, "started", "spawn-child")
        boundary(child, "started")
        notify("rawResponseItem/completed", threadId=child, item={"type": "function_call",
               "call_id": "send-parent", "name": "send_message",
               "arguments": json.dumps({"target": "/root", "message": "fixture"})})
        activity(child, root, "interacted", "send-parent")
        if current_mode == "sibling":
            sibling = root + "-sibling"
            threads[sibling] = child_metadata(sibling, root)
            activity(child, sibling, "interacted", "send-sibling")
            text(sibling, "SIBLING_FINAL", "sibling")
            boundary(sibling, "completed")
    elif current_mode in ("resumed", "stop-status", "read-failure", "foreign", "burst", "read-timeout", "missing-parent", "conflicting-parent"):
        threads[child] = child_metadata(child, root)
        if current_mode == "foreign":
            threads[child]["source"] = "vscode"
        if current_mode == "missing-parent":
            threads[child]["source"]["subAgent"]["thread_spawn"].pop("parent_thread_id")
        if current_mode == "conflicting-parent":
            threads[child]["parentThreadId"] = "foreign"
        activity(root, child, "interacted", "followup")
        if current_mode == "burst":
            for n in range(1600):
                text(root, f"BURST_{n},", "burst")
                time.sleep(0.0005)
    elif current_mode == "summary":
        read_tool("before")
        text(root, "ROOT_BEFORE_COMPACTION", "before")
        notify("item/completed", threadId=root, item={"type": "agentMessage",
               "id": "empty-placeholder", "text": ""})
        notify("thread/compacted", threadId=root)
        read_tool("after")
    read_tool("final")
    text(root, f"ROOT_FINAL_{current_mode}_{generation}", "final")
    boundary(root, "completed")
    if current_mode in ("upward", "sibling", "resumed", "burst"):
        if current_mode != "burst":
            time.sleep(2)
        text(child, "CHILD_FINAL", "child")
        boundary(child, "completed")
        notify("thread/status/changed", threadId=child, status={"type": "idle"})
    if current_mode != "legacy":
        notify("thread/status/changed", threadId=root, status={"type": "idle"})


for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    method = msg["method"]
    params = msg.get("params", {})
    result = {}
    if method == "initialize":
        result = {"userAgent": "codex-cli/0.154.0"}
    elif method == "config/read":
        result = {"config": {"model": "qa-model", "model_reasoning_effort": "low",
                             "service_tier": None}}
    elif method == "model/list":
        result = {"data": [{"id": "qa-model", "model": "qa-model", "displayName": "QA model",
                            "isDefault": True, "supportedReasoningEfforts": [],
                            "defaultReasoningEffort": "low"}], "nextCursor": None}
    elif method == "skills/list":
        result = {"data": []}
    elif method in ("thread/start", "thread/resume"):
        root = params.get("threadId", root)
        result = {"thread": {"id": root, "turns": []}}
        if method == "thread/resume" and not params.get("excludeTurns", False):
            result["thread"]["turns"] = [{"id": "old-turn", "items": [
                {"type": "agentMessage", "id": "old-item", "text": "x" * (32 * 1024 * 1024)}]}]
        servers = list(params.get("config", {}).get("mcp_servers", {}))
        for name in servers:
            notify("mcpServer/startupStatus/updated", name=name, status="ready")
    elif method == "mcpServerStatus/list":
        result = {"data": [{"name": name, "authStatus": "unsupported", "tools": {}}
                           for name in servers], "nextCursor": None}
    elif method == "turn/start":
        generation += 1
        mode = " ".join(i.get("text", "") for i in params.get("input", []))
        emit({"id": msg["id"], "result": {"turn": {"id": root + "-turn-" + str(generation)}}})
        threading.Thread(target=scenario, args=(mode,), daemon=True).start()
        continue
    elif method == "thread/read":
        if mode == "read-failure":
            emit({"id": msg["id"], "error": {"code": -32000, "message": "METADATA_READ_FAILED"}})
            continue
        if mode == "read-timeout":
            continue
        thread = params["threadId"]
        metadata = dict(threads[thread])
        metadata["turns"] = [{"id": thread + "-turn-" + str(generation), "items": []}]
        result = {"thread": metadata}
        if mode == "burst":
            threading.Timer(2, emit, args=({"id": msg["id"], "result": result},)).start()
            continue
    elif method == "turn/interrupt":
        boundary(params["threadId"], "completed")
    elif method == "thread/unsubscribe" and mode == "close-error":
        emit({"id": msg["id"], "error": {"code": -32000, "message": "UNSUBSCRIBE_FAILED"}})
        continue
    elif method == "thread/unsubscribe" and mode == "close-timeout":
        continue
    emit({"id": msg["id"], "result": result})
