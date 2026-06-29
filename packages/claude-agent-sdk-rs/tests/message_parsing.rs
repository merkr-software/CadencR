use claude_agent_sdk_rs::messages::{SdkMessage, StreamEventData, SystemMessage};
use claude_agent_sdk_rs::types::{ContentBlock, ContentDelta};
use serde_json::json;

// ── StreamEvent: content_block_delta ────────────────────────────────────────

#[test]
fn stream_event_text_delta() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u1",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "hello" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(msg.is_content_delta());
    assert_eq!(msg.session_id(), Some("s1"));
    if let SdkMessage::StreamEvent {
        event: StreamEventData::ContentBlockDelta { delta, .. },
        ..
    } = &msg
    {
        assert!(matches!(delta, ContentDelta::TextDelta { text } if text == "hello"));
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn stream_event_thinking_delta() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u2",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "thinking_delta", "thinking": "step 1" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(msg.is_content_delta());
}

#[test]
fn stream_event_input_json_delta() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u3",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": "{\"cmd\":" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(msg.is_content_delta());
}

#[test]
fn stream_event_message_start() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u4",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "message_start",
            "message": { "id": "msg_1", "model": "claude-opus-4-5", "type": "message" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(!msg.is_content_delta());
    assert!(!msg.is_turn_complete());
}

#[test]
fn stream_event_content_block_start() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u5",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(!msg.is_content_delta());
}

#[test]
fn stream_event_content_block_stop() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u6",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": { "type": "content_block_stop", "index": 0 }
    });
    let _msg: SdkMessage = serde_json::from_value(raw).unwrap();
}

#[test]
fn stream_event_message_delta() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u7",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "input_tokens": 10, "output_tokens": 20 }
        }
    });
    let _msg: SdkMessage = serde_json::from_value(raw).unwrap();
}

#[test]
fn stream_event_message_stop() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u8",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": { "type": "message_stop" }
    });
    let _msg: SdkMessage = serde_json::from_value(raw).unwrap();
}

// ── Result message ───────────────────────────────────────────────────────────

#[test]
fn result_success() {
    let raw = json!({
        "type": "result",
        "subtype": "success",
        "uuid": "r1",
        "session_id": "s1",
        "duration_ms": 1234,
        "duration_api_ms": 800,
        "is_error": false,
        "num_turns": 3,
        "result": "Done",
        "total_cost_usd": 0.002,
        "usage": { "input_tokens": 100, "output_tokens": 50 },
        "permission_denials": []
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(msg.is_turn_complete());
    assert_eq!(msg.session_id(), Some("s1"));
    if let SdkMessage::Result {
        subtype,
        usage,
        is_error,
        ..
    } = &msg
    {
        assert_eq!(subtype, "success");
        assert!(!is_error);
        assert_eq!(usage.output_tokens, 50);
    } else {
        panic!("wrong variant");
    }
    // usage() excludes Result (cumulative), but cumulative_usage() returns it
    assert!(msg.usage().is_none());
    assert!(msg.cumulative_usage().is_some());
}

#[test]
fn result_exposes_context_window_from_model_usage() {
    let raw = json!({
        "type": "result",
        "subtype": "success",
        "uuid": "r3",
        "session_id": "s1",
        "duration_ms": 4000,
        "duration_api_ms": 1400,
        "is_error": false,
        "num_turns": 1,
        "result": "hi",
        "total_cost_usd": 0.07,
        "usage": { "input_tokens": 6, "output_tokens": 6 },
        "permission_denials": [],
        "modelUsage": {
            "claude-opus-4-7[1m]": {
                "inputTokens": 6,
                "outputTokens": 6,
                "contextWindow": 1000000,
                "maxOutputTokens": 64000,
                "costUSD": 0.07923125
            }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(msg.result_context_window(), Some(1_000_000));
}

#[test]
fn result_context_window_picks_largest_when_multiple_models() {
    let raw = json!({
        "type": "result",
        "subtype": "success",
        "uuid": "r4",
        "session_id": "s1",
        "duration_ms": 1,
        "duration_api_ms": 1,
        "is_error": false,
        "num_turns": 1,
        "result": "ok",
        "total_cost_usd": 0.0,
        "usage": { "input_tokens": 1, "output_tokens": 1 },
        "permission_denials": [],
        "modelUsage": {
            "claude-haiku-4-5": { "contextWindow": 200000 },
            "claude-opus-4-7[1m]": { "contextWindow": 1000000 }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(msg.result_context_window(), Some(1_000_000));
}

#[test]
fn result_context_window_returns_none_when_absent() {
    let raw = json!({
        "type": "result",
        "subtype": "success",
        "uuid": "r5",
        "session_id": "s1",
        "duration_ms": 1,
        "duration_api_ms": 1,
        "is_error": false,
        "num_turns": 1,
        "result": "ok",
        "total_cost_usd": 0.0,
        "usage": { "input_tokens": 1, "output_tokens": 1 },
        "permission_denials": []
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(msg.result_context_window(), None);
}

#[test]
fn result_error_max_turns() {
    let raw = json!({
        "type": "result",
        "subtype": "error_max_turns",
        "uuid": "r2",
        "session_id": "s1",
        "duration_ms": 5000,
        "duration_api_ms": 4000,
        "is_error": true,
        "num_turns": 10,
        "errors": ["Max turns reached"],
        "total_cost_usd": 0.01,
        "usage": { "input_tokens": 500, "output_tokens": 100 },
        "permission_denials": []
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(msg.is_turn_complete());
    if let SdkMessage::Result {
        subtype,
        errors,
        is_error,
        ..
    } = &msg
    {
        assert_eq!(subtype, "error_max_turns");
        assert!(is_error);
        assert_eq!(errors.as_ref().unwrap()[0], "Max turns reached");
    } else {
        panic!("wrong variant");
    }
}

// ── System init ──────────────────────────────────────────────────────────────

#[test]
fn system_init() {
    let raw = json!({
        "type": "system",
        "subtype": "init",
        "uuid": "sys1",
        "session_id": "sess_abc",
        "claude_code_version": "1.0.0",
        "cwd": "/home/user",
        "tools": ["bash", "read"],
        "mcp_servers": [],
        "model": "claude-opus-4-5",
        "permission_mode": "default",
        "slash_commands": [],
        "output_style": "streaming"
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(!msg.is_turn_complete());
    assert_eq!(msg.session_id(), Some("sess_abc"));
    assert!(!msg.is_compaction());
    if let SdkMessage::System(SystemMessage::Init {
        session_id,
        model,
        tools,
        ..
    }) = &msg
    {
        assert_eq!(session_id, "sess_abc");
        assert_eq!(model, "claude-opus-4-5");
        assert_eq!(tools[0], "bash");
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn system_init_with_camel_case_permission_mode() {
    // Current CLI versions emit `permissionMode` (camelCase) — the one
    // field that diverges from snake_case. A failure here silently turns
    // every init message into `SdkMessage::Unknown` downstream.
    let raw = json!({
        "type": "system",
        "subtype": "init",
        "uuid": "sys2",
        "session_id": "sess_def",
        "claude_code_version": "2.0.75",
        "cwd": "/home/user",
        "tools": ["Bash", "Read"],
        "mcp_servers": [],
        "model": "claude-fable-5[1m]",
        "permissionMode": "default",
        "slash_commands": [],
        "output_style": "default",
        "apiKeySource": "none",
        "agents": ["Explore"],
        "skills": []
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    if let SdkMessage::System(SystemMessage::Init {
        model,
        permission_mode,
        ..
    }) = &msg
    {
        assert_eq!(model, "claude-fable-5[1m]");
        assert_eq!(permission_mode, "default");
    } else {
        panic!("init with camelCase permissionMode must not fall back to Unknown: {msg:?}");
    }
}

// ── System compact_boundary ──────────────────────────────────────────────────

#[test]
fn system_compact_boundary() {
    let raw = json!({
        "type": "system",
        "subtype": "compact_boundary",
        "uuid": "cb1",
        "session_id": "sess_abc",
        "compact_metadata": { "trigger": "token_limit", "pre_tokens": 90000 }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(msg.is_compaction());
    assert_eq!(msg.session_id(), Some("sess_abc"));
}

// ── System status (compaction lifecycle) ─────────────────────────────────────
// These are the exact shapes the CLI emits around `/compact`, captured by
// driving the real `claude` binary. The `status: "compacting"` event is the
// in-progress signal issue #60 was missing.

#[test]
fn system_status_compacting_started() {
    let raw = json!({
        "type": "system",
        "subtype": "status",
        "status": "compacting",
        "session_id": "sess_abc",
        "uuid": "st1"
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(msg.session_id(), Some("sess_abc"));
    let SdkMessage::System(system) = &msg else {
        panic!("expected System, got {msg:?}");
    };
    assert!(system.is_compaction_started());
}

/// The critical regression guard for issue #60: an untyped `system/status`
/// degrades to `SdkMessage::Unknown`, whose `raw` serializes to `null` and is
/// dropped before reaching the frontend. A typed variant must round-trip with
/// `type` / `subtype` / `status` intact so the raw passthrough survives.
#[test]
fn roundtrip_system_status_preserves_raw_shape() {
    let raw = json!({
        "type": "system",
        "subtype": "status",
        "status": "compacting",
        "session_id": "s1",
        "uuid": "rt-status"
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_value(&msg).unwrap();
    assert_eq!(serialized["type"], "system");
    assert_eq!(serialized["subtype"], "status");
    assert_eq!(serialized["status"], "compacting");
    assert_eq!(serialized["session_id"], "s1");
}

// ── Assistant message ────────────────────────────────────────────────────────

#[test]
fn assistant_message_with_usage() {
    let raw = json!({
        "type": "assistant",
        "uuid": "a1",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "error": null,
        "message": {
            "id": "msg_1",
            "model": "claude-opus-4-5",
            "content": [{ "type": "text", "text": "Hello!" }],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 200, "output_tokens": 40 }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(!msg.is_turn_complete());
    assert!(!msg.is_content_delta());
    let usage = msg.usage().expect("should have usage");
    assert_eq!(usage.input_tokens, 200);
    assert_eq!(usage.output_tokens, 40);
}

// ── User message ─────────────────────────────────────────────────────────────

#[test]
fn user_message_with_tool_use_result() {
    let raw = json!({
        "type": "user",
        "uuid": "usr1",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "message": { "role": "user", "content": "hi" },
        "tool_use_result": { "tool_use_id": "t1", "content": "ok" }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(msg.session_id(), Some("s1"));
    if let SdkMessage::User {
        tool_use_result, ..
    } = &msg
    {
        assert!(tool_use_result.is_some());
    } else {
        panic!("wrong variant");
    }
}

// ── Unknown type fallback ────────────────────────────────────────────────────

#[test]
fn unknown_type_falls_back_to_unknown() {
    let raw = json!({
        "type": "future_unknown_type",
        "uuid": "unk1",
        "session_id": "s1",
        "some_field": 42
    });
    let msg: SdkMessage = serde_json::from_value(raw.clone()).unwrap();
    assert!(matches!(msg, SdkMessage::Unknown(_)));
    assert_eq!(msg.session_id(), None);
    assert!(!msg.is_turn_complete());
    assert!(!msg.is_content_delta());
    assert!(msg.usage().is_none());
    assert!(!msg.is_compaction());
}

// ── Malformed JSON ───────────────────────────────────────────────────────────

#[test]
fn malformed_json_produces_error() {
    let result: Result<SdkMessage, _> = serde_json::from_str("{not valid json}");
    assert!(result.is_err());
}

// ── Helper method correctness ─────────────────────────────────────────────────

#[test]
fn helpers_on_non_matching_variants() {
    // A StreamEvent(message_stop) should NOT be is_content_delta
    let raw = json!({
        "type": "stream_event",
        "uuid": "x",
        "session_id": "s",
        "parent_tool_use_id": null,
        "event": { "type": "message_stop" }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(!msg.is_content_delta());
    assert!(!msg.is_turn_complete());
    assert!(msg.usage().is_none());
    assert!(!msg.is_compaction());
}

// ── Serde roundtrip (Serialize + Deserialize) ─────────────────────────────────

#[test]
fn roundtrip_stream_event() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "rt1",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "event": {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "hi" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_string(&msg).unwrap();
    let back: SdkMessage = serde_json::from_str(&serialized).unwrap();
    assert!(back.is_content_delta());
}

#[test]
fn roundtrip_result() {
    let raw = json!({
        "type": "result",
        "subtype": "success",
        "uuid": "rt2",
        "session_id": "s1",
        "duration_ms": 100u64,
        "duration_api_ms": 80u64,
        "is_error": false,
        "num_turns": 1u64,
        "result": "ok",
        "total_cost_usd": 0.001,
        "usage": { "input_tokens": 10u64, "output_tokens": 5u64 },
        "permission_denials": []
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_string(&msg).unwrap();
    let back: SdkMessage = serde_json::from_str(&serialized).unwrap();
    assert!(back.is_turn_complete());
}

#[test]
fn roundtrip_system_init() {
    let raw = json!({
        "type": "system",
        "subtype": "init",
        "uuid": "rt3",
        "session_id": "s1",
        "claude_code_version": "1.0",
        "cwd": "/",
        "tools": [],
        "mcp_servers": [],
        "model": "claude-opus-4-5",
        "permission_mode": "default",
        "slash_commands": [],
        "output_style": "streaming"
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_string(&msg).unwrap();
    let back: SdkMessage = serde_json::from_str(&serialized).unwrap();
    assert_eq!(back.session_id(), Some("s1"));
    assert!(!back.is_compaction());
}

#[test]
fn roundtrip_system_compact_boundary() {
    let raw = json!({
        "type": "system",
        "subtype": "compact_boundary",
        "uuid": "rt4",
        "session_id": "s1",
        "compact_metadata": { "trigger": "auto", "pre_tokens": 50000u64 }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_string(&msg).unwrap();
    let back: SdkMessage = serde_json::from_str(&serialized).unwrap();
    assert!(back.is_compaction());
}

#[test]
fn roundtrip_assistant() {
    let raw = json!({
        "type": "assistant",
        "uuid": "rt5",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "error": null,
        "message": {
            "id": "m1",
            "model": "claude-opus-4-5",
            "content": [],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 1u64, "output_tokens": 1u64 }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_string(&msg).unwrap();
    let back: SdkMessage = serde_json::from_str(&serialized).unwrap();
    assert!(back.usage().is_some());
}

#[test]
fn roundtrip_user() {
    let raw = json!({
        "type": "user",
        "uuid": "rt6",
        "session_id": "s1",
        "parent_tool_use_id": null,
        "message": { "role": "user", "content": "hello" }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_string(&msg).unwrap();
    let back: SdkMessage = serde_json::from_str(&serialized).unwrap();
    assert_eq!(back.session_id(), Some("s1"));
}

// ── Schema-drift resilience ─────────────────────────────────────────────────
// The CLI ships frequently; a new content-block / delta / stream-event /
// system-subtype must NOT sink the whole message into `Unknown` (which drops it
// silently from the conversation). Unknown *siblings* degrade to `Other` while
// known data beside them survives.

#[test]
fn assistant_with_unknown_content_block_keeps_known_text() {
    let raw = json!({
        "type": "assistant",
        "uuid": "a1",
        "session_id": "s1",
        "message": {
            "id": "m1",
            "model": "claude-opus-4-8",
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "server_tool_use", "id": "srv1", "name": "web_search", "input": {} }
            ]
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    match msg {
        SdkMessage::Assistant { message, .. } => {
            assert_eq!(message.content.len(), 2);
            assert!(matches!(&message.content[0], ContentBlock::Text { text } if text == "hello"));
            assert!(matches!(&message.content[1], ContentBlock::Other));
        }
        other => panic!("unknown block must not sink the assistant message: {other:?}"),
    }
}

#[test]
fn stream_event_with_unknown_delta_stays_stream_event() {
    // e.g. a `signature_delta` for thinking blocks.
    let raw = json!({
        "type": "stream_event",
        "uuid": "u1",
        "session_id": "s1",
        "event": {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "signature_delta", "signature": "abc" }
        }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    match msg {
        SdkMessage::StreamEvent {
            event: StreamEventData::ContentBlockDelta { delta, .. },
            ..
        } => assert!(matches!(delta, ContentDelta::Other)),
        other => panic!("unknown delta must not sink the stream event: {other:?}"),
    }
}

#[test]
fn unknown_stream_event_type_stays_stream_event() {
    let raw = json!({
        "type": "stream_event",
        "uuid": "u1",
        "session_id": "s1",
        "event": { "type": "some_future_event", "foo": 1 }
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    match msg {
        SdkMessage::StreamEvent { event, .. } => assert!(matches!(event, StreamEventData::Other)),
        other => panic!("unknown stream event must not become Unknown: {other:?}"),
    }
}

#[test]
fn system_init_survives_missing_noncritical_fields() {
    // A future CLI that drops/renames any field except session_id+model must
    // still yield `Init` so the critical session_id capture never fails.
    let raw = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "sess_min",
        "model": "claude-opus-4-8"
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert_eq!(msg.session_id(), Some("sess_min"));
    assert!(
        matches!(msg, SdkMessage::System(SystemMessage::Init { .. })),
        "init with only session_id+model must not fall back to Unknown"
    );
}

#[test]
fn unknown_system_subtype_falls_back_to_unknown_for_background_agent_protocol() {
    // Intentional: `system/task_started` & `task_notification` MUST stay
    // `Unknown(raw)` so the run-in-background agent protocol can read their raw
    // fields (issue #58). So a system message with an untyped subtype is the
    // one place we deliberately do NOT add a catch-all.
    let raw = json!({
        "type": "system",
        "subtype": "task_started",
        "session_id": "s1",
        "uuid": "u1",
        "task_id": "t1"
    });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(matches!(msg, SdkMessage::Unknown(_)), "got {msg:?}");
}

#[test]
fn genuinely_unknown_top_level_type_still_falls_back_to_unknown() {
    // The catch-alls are scoped to *known* containers; a wholly unknown
    // top-level message type still becomes `Unknown` (and is logged).
    let raw = json!({ "type": "some_future_top_level", "session_id": "s1" });
    let msg: SdkMessage = serde_json::from_value(raw).unwrap();
    assert!(matches!(msg, SdkMessage::Unknown(_)), "got {msg:?}");
}
