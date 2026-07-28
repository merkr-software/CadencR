mod implementation;
pub(crate) use implementation::parse_available_commands;
pub use implementation::{mirror_session_info_update, session_update_to_events};
#[cfg(test)]
mod tests {
    use super::super::events_stream_blocks::EventIndexer;
    use super::super::provider_hooks::AcpProviderHooks;
    use super::{mirror_session_info_update, session_update_to_events};
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimePermissionMode,
        RuntimeStreamEvent,
    };
    use serde_json::{json, Value};
    struct PlainHooks;
    impl AcpProviderHooks for PlainHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
            json!(blocks)
        }
        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }
    }
    fn run_chunk(idx: &mut EventIndexer, kind: &str, text: &str) -> Vec<RuntimeEvent> {
        session_update_to_events(
            &json!({
                "update": { "sessionUpdate": kind, "content": text }
            }),
            idx,
            None,
            None,
            &PlainHooks,
        )
        .events
    }
    #[test]
    fn first_text_chunk_emits_message_start_then_block_start_then_delta() {
        let mut idx = EventIndexer::default();
        let events = run_chunk(&mut idx, "agent_message_chunk", "hello");
        assert_eq!(events.len(), 3);
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::MessageStart { .. })
        ));
        assert!(matches!(
            events[1].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::Text { .. },
                ..
            })
        ));
        match events[2].stream_event() {
            Some(RuntimeStreamEvent::ContentBlockDelta {
                delta: RuntimeContentDelta::Text { text },
                ..
            }) => assert_eq!(text, "hello"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn consecutive_text_chunks_share_index_and_emit_only_deltas() {
        let mut idx = EventIndexer::default();
        let first = run_chunk(&mut idx, "agent_message_chunk", "P");
        let second = run_chunk(&mut idx, "agent_message_chunk", "ONG");
        assert_eq!(first.len(), 3);
        assert_eq!(second.len(), 1);
        let first_idx = match first[1].stream_event() {
            Some(RuntimeStreamEvent::ContentBlockStart { index, .. }) => *index,
            other => panic!("unexpected variant: {other:?}"),
        };
        match second[0].stream_event() {
            Some(RuntimeStreamEvent::ContentBlockDelta { index, .. }) => {
                assert_eq!(*index, first_idx)
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn thought_chunk_emits_thinking_block_and_delta() {
        let mut idx = EventIndexer::default();
        let events = run_chunk(&mut idx, "agent_thought_chunk", "considering");
        assert_eq!(events.len(), 3);
        assert!(matches!(
            events[0].stream_event(),
            Some(RuntimeStreamEvent::MessageStart { .. })
        ));
        assert!(matches!(
            events[1].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::Thinking { .. },
                ..
            })
        ));
        match events[2].stream_event() {
            Some(RuntimeStreamEvent::ContentBlockDelta {
                delta: RuntimeContentDelta::Thinking { thinking },
                ..
            }) => assert_eq!(thinking, "considering"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }
    #[test]
    fn tool_call_after_text_flushes_streaming_block_first() {
        let mut idx = EventIndexer::default();
        let _ = run_chunk(&mut idx, "agent_message_chunk", "hi");
        let tool_events = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t1",
                    "toolName": "Bash",
                    "toolInput": { "command": "ls" }
                }
            }),
            &mut idx,
            None,
            None,
            &PlainHooks,
        )
        .events;
        assert!(matches!(
            tool_events[0].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStop { .. })
        ));
        assert!(matches!(
            tool_events[1].stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::ToolUse { .. },
                ..
            })
        ));
    }
    #[test]
    fn usage_update_populates_metadata_for_context_budget() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "usage_update",
                    "used": 10_653,
                    "size": 200_000,
                    "cost": { "amount": 0, "currency": "USD" },
                }
            }),
            &mut idx,
            None,
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        let usage = event.usage().expect("usage_update must carry a usage");
        assert_eq!(usage.input_tokens, 10_653);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(event.context_window(), Some(200_000));
        assert!(
            event.token_usage().is_none(),
            "context occupancy is not accounting for providers with end-turn usage",
        );
    }
    #[test]
    fn unknown_variant_falls_back_to_other_without_panicking() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({ "update": { "sessionUpdate": "exotic", "anything": 1 } }),
            &mut idx,
            None,
            None,
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        assert!(result.events[0].init().is_none());
    }
    #[test]
    fn user_message_chunk_emits_event_carrying_raw_content() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "echoed prompt" }
                }
            }),
            &mut idx,
            None,
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert!(event.user_message().is_none());
        assert!(event.assistant_message().is_none());
        let raw = event.raw_json();
        assert_eq!(
            raw["update"]["content"]["text"],
            json!("echoed prompt"),
            "raw payload must surface the chunk so it isn't dropped",
        );
    }
    #[test]
    fn user_message_chunk_compaction_emits_compact_boundary() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "compaction", "auto": false, "overflow": false }
                }
            }),
            &mut idx,
            None,
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        assert!(result.events[0].is_compact_boundary());
        assert_eq!(result.events[0].session_id(), Some("s-1"));
    }
    #[test]
    fn session_info_update_populates_context_window_metadata() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "session_info_update",
                    "contextWindow": { "tokenUsed": 4242, "maxTokens": 200_000 },
                    "model": "anthropic/claude-4.7",
                    "title": "auto-named",
                }
            }),
            &mut idx,
            None,
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        let event = &result.events[0];
        assert_eq!(event.context_window(), Some(200_000));
        let usage = event
            .usage()
            .expect("session_info_update must surface usage");
        assert_eq!(usage.input_tokens, 4242);
        assert!(event.token_usage().is_none());
    }
    #[tokio::test]
    async fn mirror_session_info_update_writes_current_model() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let model = Arc::new(RwLock::new(Some("old".to_string())));
        let body = json!({
            "sessionUpdate": "session_info_update",
            "model": "anthropic/claude-4.7",
        });
        mirror_session_info_update(&body, &model).await;
        assert_eq!(model.read().await.as_deref(), Some("anthropic/claude-4.7"));
    }
    #[tokio::test]
    async fn mirror_session_info_update_leaves_model_alone_when_absent() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let model = Arc::new(RwLock::new(Some("keep".to_string())));
        let body = json!({ "sessionUpdate": "session_info_update", "title": "renamed" });
        mirror_session_info_update(&body, &model).await;
        assert_eq!(model.read().await.as_deref(), Some("keep"));
    }
    #[test]
    fn available_commands_update_emits_typed_slash_commands_event() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "compact", "description": "summarize" },
                        { "name": "init", "description": "init" }
                    ]
                }
            }),
            &mut idx,
            None,
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        let commands = result.events[0]
            .slash_commands_updated()
            .expect("expected SlashCommandsUpdated event");
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "compact");
        assert_eq!(commands[0].description.as_deref(), Some("summarize"));
        assert_eq!(commands[1].name, "init");
    }
    #[test]
    fn available_commands_update_emits_empty_list_when_array_empty() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": []
                }
            }),
            &mut idx,
            None,
            None,
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        let commands = result.events[0]
            .slash_commands_updated()
            .expect("expected SlashCommandsUpdated event");
        assert!(commands.is_empty());
    }
    #[test]
    fn current_mode_update_carries_raw_provider_extension_into_metadata() {
        let mut idx = EventIndexer::default();
        let mapped = session_update_to_events(
            &json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "current_mode_update",
                    "currentModeId": "edit",
                    "providerExtension": "preserved"
                }
            }),
            &mut idx,
            Some("gpt-5"),
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(mapped.events.len(), 1);
        let raw = mapped.events[0].raw_json();
        assert_eq!(raw["update"]["providerExtension"], "preserved");
        assert_eq!(raw["update"]["currentModeId"], "edit");
    }
    #[test]
    fn available_commands_update_skips_entries_without_name() {
        let mut idx = EventIndexer::default();
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "description": "no name here" },
                        { "name": "valid" }
                    ]
                }
            }),
            &mut idx,
            None,
            None,
            &PlainHooks,
        );
        let commands = result.events[0].slash_commands_updated().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "valid");
        assert!(commands[0].description.is_none());
    }
    #[test]
    fn non_streaming_update_without_open_blocks_preserves_message_start() {
        let mut idx = EventIndexer::default();
        idx.message_started = true;
        let result = session_update_to_events(
            &json!({
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "missing-start",
                    "status": "pending"
                }
            }),
            &mut idx,
            Some("openai/gpt-5.4"),
            Some("s-1"),
            &PlainHooks,
        );
        assert_eq!(result.events.len(), 1);
        assert!(idx.message_started);
    }
}
