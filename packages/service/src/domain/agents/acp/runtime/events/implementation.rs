//! ACP `session/update` notification → Cadencr `RuntimeEvent` mapping.
//! Sole place that knows the ACP wire shape of streamed agent output.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

use crate::domain::agents::adapter::{
    RuntimeCompactMetadata, RuntimeContentDelta, RuntimeEvent, RuntimeEventKind,
    RuntimeEventMetadata, RuntimeSlashCommand, RuntimeSlashCommandKind, RuntimeUsage,
};

use super::super::events_config_option::map_config_option_update;
use super::super::events_plan::map_plan;
use super::super::events_stream_blocks::{
    drain_streaming_block_stops, message_start_for, stream_delta_event, stream_start_event,
    stream_stop_event, EventIndexer,
};
use super::super::events_tool_call::{map_tool_call_start, MappedUpdate};
use super::super::events_tool_call_update::map_tool_call_update;
use super::super::provider_hooks::AcpProviderHooks;

/// Map one `session/update` payload into a sequence of `RuntimeEvent`s.
///
/// The caller (the event loop) is responsible for stamping
/// `parent_tool_use_id` and forwarding to the local channel.
pub fn session_update_to_events(
    params: &Value,
    indexer: &mut EventIndexer,
    active_model: Option<&str>,
    session_id: Option<&str>,
    hooks: &dyn AcpProviderHooks,
) -> MappedUpdate {
    let raw_kind = params
        .get("update")
        .and_then(|u| u.get("sessionUpdate"))
        .or_else(|| params.get("sessionUpdate"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let kind = raw_kind;

    // Nested under `update` for OpenCode; some adapters embed at top level.
    // Borrowed (no clone) — the inner mappers all take `&Value`. The single
    // clone we still pay is in `base_metadata::raw`, where ownership is real.
    let body = params.get("update").unwrap_or(params);

    let metadata = base_metadata(params, session_id);

    match kind {
        "agent_message_chunk" | "agent_thought_chunk" => {
            map_agent_chunk(kind, body, indexer, active_model, metadata)
        }
        "tool_call" => {
            let mapped = map_tool_call_start(body, indexer, metadata.clone(), hooks);
            prepend_streaming_stops(indexer, &metadata, mapped)
        }
        "tool_call_update" => {
            let mapped = map_tool_call_update(body, indexer, metadata.clone(), hooks);
            prepend_streaming_stops(indexer, &metadata, mapped)
        }
        "plan" => {
            let mapped = map_plan(body, indexer, active_model, metadata.clone());
            prepend_streaming_stops(indexer, &metadata, mapped)
        }
        "current_mode_update" => MappedUpdate {
            events: vec![other_event(metadata)],
        },
        "available_commands_update" => MappedUpdate {
            events: vec![map_available_commands_update(body, metadata)],
        },
        "user_message_chunk" => MappedUpdate {
            events: vec![map_user_message_chunk(body, indexer, metadata)],
        },
        "session_info_update" => MappedUpdate {
            events: vec![map_session_info_update(body, metadata)],
        },
        "config_option_update" => MappedUpdate {
            events: vec![map_config_option_update(metadata)],
        },
        "usage_update" => MappedUpdate {
            events: vec![map_usage_update(body, metadata)],
        },
        other => {
            tracing::debug!(kind = other, "unhandled ACP session/update variant");
            MappedUpdate {
                events: vec![other_event(metadata)],
            }
        }
    }
}

/// Close any open text/thinking block before a tool/plan update so the FE
/// sees a proper Stop boundary and starts a fresh `message_start` for the
/// next text segment.
fn prepend_streaming_stops(
    indexer: &mut EventIndexer,
    metadata: &RuntimeEventMetadata,
    next: MappedUpdate,
) -> MappedUpdate {
    let mut events = drain_streaming_block_stops(indexer, metadata.session_id.as_deref());
    if events.is_empty() {
        return next;
    }
    indexer.message_started = false;
    events.extend(next.events);
    MappedUpdate { events }
}

fn base_metadata(params: &Value, session_id: Option<&str>) -> RuntimeEventMetadata {
    RuntimeEventMetadata {
        session_id: session_id.map(ToOwned::to_owned),
        usage: None,
        context_window: None,
        raw: params.clone(),
    }
}

fn map_agent_chunk(
    kind: &str,
    body: &Value,
    indexer: &mut EventIndexer,
    active_model: Option<&str>,
    metadata: RuntimeEventMetadata,
) -> MappedUpdate {
    let content = body.get("content").cloned().unwrap_or(Value::Null);
    let (text, content_kind) = extract_chunk_text(&content);
    if text.is_empty() {
        return MappedUpdate {
            events: vec![other_event(metadata)],
        };
    }
    let is_thinking = matches!(
        (kind, content_kind),
        ("agent_thought_chunk", _) | (_, ChunkKind::Thinking)
    );
    let session_id = metadata.session_id.as_deref();
    let mut events = Vec::with_capacity(4);

    if !indexer.message_started {
        events.push(message_start_for(session_id, active_model));
        indexer.message_started = true;
    }

    let stale = if is_thinking {
        indexer.current_text_index.take()
    } else {
        indexer.current_thinking_index.take()
    };
    if let Some(stale_index) = stale {
        events.push(stream_stop_event(stale_index, session_id));
    }

    let (index, is_new) = if is_thinking {
        indexer.open_thinking_block()
    } else {
        indexer.open_text_block()
    };

    if is_new {
        events.push(stream_start_event(index, is_thinking, session_id));
    }
    let delta = if is_thinking {
        RuntimeContentDelta::Thinking { thinking: text }
    } else {
        RuntimeContentDelta::Text { text }
    };
    events.push(stream_delta_event(index, delta, session_id));
    MappedUpdate { events }
}

#[derive(Clone, Copy)]
enum ChunkKind {
    Text,
    Thinking,
}

fn extract_chunk_text(content: &Value) -> (String, ChunkKind) {
    if let Some(text) = content.as_str() {
        return (text.to_string(), ChunkKind::Text);
    }
    let kind = content
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let text = content
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let chunk_kind = if kind == "thinking" {
        ChunkKind::Thinking
    } else {
        ChunkKind::Text
    };
    (text, chunk_kind)
}

pub fn other_event(metadata: RuntimeEventMetadata) -> RuntimeEvent {
    RuntimeEvent::new(metadata, RuntimeEventKind::Other)
}

/// Map `usage_update` session update into a `RuntimeEvent` whose metadata
/// carries the live context-budget snapshot.
fn map_usage_update(body: &Value, mut metadata: RuntimeEventMetadata) -> RuntimeEvent {
    let used = body.get("used").and_then(Value::as_u64);
    let size = body.get("size").and_then(Value::as_u64);
    if let Some(input_tokens) = used {
        metadata.usage = Some(RuntimeUsage {
            input_tokens,
            output_tokens: 0,
        });
    }
    if size.is_some() {
        metadata.context_window = size;
    }
    RuntimeEvent::new(metadata, RuntimeEventKind::Other)
}

/// Map `user_message_chunk` (mid-turn user-side echo) into a `RuntimeEvent`.
///
/// `RuntimeUserContentBlock` only models `ToolResult`/`Other` today, so a
/// plain text echo has no clean typed home. We emit `Other` and rely on
/// `metadata.raw` (which already carries the full original payload, including
/// the `content` block) so the chunk is not dropped on the floor and can be
/// inspected by downstream consumers without inventing a new public variant.
fn map_user_message_chunk(
    body: &Value,
    indexer: &mut EventIndexer,
    mut metadata: RuntimeEventMetadata,
) -> RuntimeEvent {
    let content = body.get("content").cloned().unwrap_or(Value::Null);
    if content.get("type").and_then(Value::as_str) == Some("compaction") {
        indexer.mark_compact_boundary_emitted();
        let trigger = if content
            .get("auto")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            Some("auto".to_string())
        } else {
            Some("manual".to_string())
        };
        let compact_metadata = RuntimeCompactMetadata {
            trigger,
            pre_tokens: None,
        };
        let provider_raw = metadata.raw.clone();
        metadata.raw = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "session_id": metadata.session_id,
            "compact_metadata": {
                "trigger": compact_metadata.trigger.clone(),
                "pre_tokens": compact_metadata.pre_tokens,
            },
            "provider_raw": provider_raw,
        });
        return RuntimeEvent::new(
            metadata,
            RuntimeEventKind::CompactBoundary {
                metadata: Some(compact_metadata),
            },
        );
    }
    let (text, _kind) = extract_chunk_text(&content);
    if !text.is_empty() {
        tracing::debug!(len = text.len(), "ACP user_message_chunk received");
    }
    RuntimeEvent::new(metadata, RuntimeEventKind::Other)
}

/// Map `session_info_update` into a `RuntimeEvent` whose metadata carries
/// any reported `contextWindow` snapshot (`tokenUsed` / `maxTokens`).
///
/// Mutating session-level state (`current_model`, title) lives in
/// `mirror_session_info_update`, which the event loop calls alongside the
/// other state mirrors so we don't smuggle locks into the sync mapper.
fn map_session_info_update(body: &Value, mut metadata: RuntimeEventMetadata) -> RuntimeEvent {
    if let Some(window) = body.get("contextWindow") {
        let used = window
            .get("tokenUsed")
            .or_else(|| window.get("used"))
            .and_then(Value::as_u64);
        let max = window
            .get("maxTokens")
            .or_else(|| window.get("size"))
            .and_then(Value::as_u64);
        if let Some(input_tokens) = used {
            metadata.usage = Some(RuntimeUsage {
                input_tokens,
                output_tokens: 0,
            });
        }
        if max.is_some() {
            metadata.context_window = max;
        }
    }
    RuntimeEvent::new(metadata, RuntimeEventKind::Other)
}

/// Map `available_commands_update` into a typed `SlashCommandsUpdated`
/// event carrying the full agent-advertised catalog.
///
/// ACP wire shape: `{ availableCommands: [{ name, description?, … }] }`.
/// Each entry maps to `RuntimeSlashCommand` with kind `Command` (ACP
/// doesn't distinguish skills) unless it carries `_meta.cadencr.kind:
/// "skill"`, the same kind a provider package's `slash-commands` listing
/// reports for it. The provider-neutral
/// `RuntimeEventKind::SlashCommandsUpdated` lets the WS bridge fan
/// updates out to live FE pickers; the per-cwd snapshot store the
/// synchronous `commands.get` reads back is mirrored separately by the
/// provider's `AcpProviderHooks::record_available_commands` hook.
fn map_available_commands_update(body: &Value, metadata: RuntimeEventMetadata) -> RuntimeEvent {
    let commands = parse_available_commands(body);
    tracing::info!(count = commands.len(), "acp_available_commands");
    RuntimeEvent::new(
        metadata,
        RuntimeEventKind::SlashCommandsUpdated(Arc::new(commands)),
    )
}

/// Parse the `availableCommands` array off a `session/update` body
/// into the provider-neutral runtime shape. Reused by
/// `event_loop_state` (to mirror the parsed catalog through the
/// provider hook) and by `opencode::commands::probe_inner` (to parse
/// the same notification when the ephemeral refresh probe receives
/// it directly off the broadcast channel).
pub(crate) fn parse_available_commands(body: &Value) -> Vec<RuntimeSlashCommand> {
    body.get("availableCommands")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(parse_available_command).collect())
        .unwrap_or_default()
}

fn parse_available_command(value: &Value) -> Option<RuntimeSlashCommand> {
    let name = value.get("name").and_then(Value::as_str)?.to_string();
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let kind = match value.pointer("/_meta/cadencr/kind").and_then(Value::as_str) {
        Some("skill") => RuntimeSlashCommandKind::Skill,
        _ => RuntimeSlashCommandKind::Command,
    };
    Some(RuntimeSlashCommand {
        name,
        description,
        kind,
    })
}

/// Mirror a `session_info_update` body into the session's local state.
///
/// Companion to `map_session_info_update`: the sync mapper produces the
/// `RuntimeEvent` (with `contextWindow` already attached to metadata), and
/// this async helper writes any `model` / `title` hints into the per-session
/// RwLocks so subsequent prompts see the agent's authoritative values.
///
/// `title` is logged when present — we don't carry a per-session title lock
/// today, so the wire-debug log is the only landing place. Future work can
/// thread a title lock through `EventLoopConfig` and update it here.
pub async fn mirror_session_info_update(body: &Value, current_model: &Arc<RwLock<Option<String>>>) {
    if let Some(model) = body.get("model").and_then(Value::as_str) {
        super::super::events_config_option::write_if_changed(
            current_model,
            Some(model.to_string()),
        )
        .await;
    }
    if let Some(title) = body.get("title").and_then(Value::as_str) {
        tracing::debug!(title, "ACP session_info_update advertised title");
    }
}
