use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeEvent, RuntimeStreamEvent};

use super::subagent_window::SubagentWindow;
use super::update_context_window;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuntimeUsageSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuntimeUsageUpdate {
    pub snapshot: RuntimeUsageSnapshot,
    pub changed: bool,
    pub context_window_changed: bool,
    /// Result of `is_subagent_event` for this event. Surfaced so the
    /// stream reader can gate `persist_usage` without reclassifying.
    pub is_subagent: bool,
}

pub(crate) struct RuntimeUsageState {
    active_model: Option<String>,
    snapshot: RuntimeUsageSnapshot,
    root_session_id: Option<String>,
    subagent_window: SubagentWindow,
}

impl RuntimeUsageState {
    pub(crate) fn new(context_window: Option<u64>) -> Self {
        Self {
            active_model: None,
            snapshot: RuntimeUsageSnapshot {
                input_tokens: 0,
                output_tokens: 0,
                context_window,
            },
            root_session_id: None,
            subagent_window: SubagentWindow::new(),
        }
    }

    /// Records the runtime session id of the root agent.
    ///
    /// Once set, `apply_event` will ignore events tied to a different
    /// runtime session (e.g. some OpenCode / Codex flows that give the
    /// sub-agent its own session id). For Claude Code the session id is
    /// shared so this check alone is not sufficient — see `SubagentWindow`.
    /// Idempotent after the first set. Callers pass the result of
    /// `capture_runtime_session_id`, which already filters empty ids.
    pub(crate) fn set_root_session_id(&mut self, session_id: &str) {
        if self.root_session_id.is_none() {
            self.root_session_id = Some(session_id.to_string());
        }
    }

    /// Returns true if the event belongs to a sub-agent and should be
    /// excluded from the root agent's usage snapshot and DB token row.
    pub(crate) fn is_subagent_event(&self, runtime_event: &RuntimeEvent) -> bool {
        if runtime_event.parent_tool_use_id().is_some() {
            return true;
        }
        if let (Some(root), Some(evt_sid)) =
            (self.root_session_id.as_deref(), runtime_event.session_id())
        {
            if !evt_sid.is_empty() && root != evt_sid {
                return true;
            }
        }
        // Fallback: while a Task/Agent sub-agent is in flight, treat any
        // ambiguous same-session event as sub-agent traffic — except the
        // `Result` turn boundary (always the root's turn) and the carrier
        // messages that open or close the window.
        if self.subagent_window.is_active()
            && !runtime_event.is_result()
            && !self.subagent_window.carries_lifecycle_block(runtime_event)
        {
            return true;
        }
        false
    }

    pub(crate) fn apply_event(
        &mut self,
        runtime_adapter: Option<&dyn AgentRuntimeAdapter>,
        runtime_event: &RuntimeEvent,
    ) -> RuntimeUsageUpdate {
        if self.is_subagent_event(runtime_event) {
            // Even when usage is ignored, a root tool_result can still carry
            // `parent_tool_use_id` in some provider transcripts. Record the
            // close so the fallback window does not get stuck open.
            self.subagent_window.record_ends(runtime_event);

            return RuntimeUsageUpdate {
                snapshot: self.snapshot,
                changed: false,
                context_window_changed: false,
                is_subagent: true,
            };
        }

        let mut changed = false;
        let mut context_window_changed = false;

        if let Some(RuntimeStreamEvent::MessageStart {
            model,
            input_tokens,
        }) = runtime_event.stream_event()
        {
            if let Some(next_model) = model {
                self.active_model = Some(next_model.clone());
            }
            if let Some(next_input_tokens) = input_tokens {
                changed |= self.snapshot.input_tokens != *next_input_tokens;
                self.snapshot.input_tokens = *next_input_tokens;
            }
        }

        if let Some(next_context_window) =
            update_context_window(runtime_adapter, runtime_event, self.active_model.as_deref())
        {
            context_window_changed = self.snapshot.context_window != Some(next_context_window);
            changed |= context_window_changed;
            self.snapshot.context_window = Some(next_context_window);
        }

        if let Some(usage) = runtime_event.usage().filter(|usage| !usage.is_zero()) {
            changed |= self.snapshot.input_tokens != usage.input_tokens
                || self.snapshot.output_tokens != usage.output_tokens;
            self.snapshot.input_tokens = usage.input_tokens;
            self.snapshot.output_tokens = usage.output_tokens;
        }

        // Update the active sub-agent window AFTER classifying + updating the
        // snapshot. The carrier message that opens the window is a root
        // event — recording its tool_use here means the very next sub-agent
        // frame is correctly suppressed.
        self.subagent_window.record_starts(runtime_event);
        self.subagent_window.record_ends(runtime_event);

        RuntimeUsageUpdate {
            snapshot: self.snapshot,
            changed,
            context_window_changed,
            is_subagent: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::RuntimeUsageState;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeStreamEvent, RuntimeUsage, RuntimeUserContentBlock,
        RuntimeUserMessage,
    };

    fn make_message_start(
        session_id: &str,
        input_tokens: u64,
        parent_tool_use_id: Option<&str>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(session_id.into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "stream_event" }),
            },
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::MessageStart {
                    model: Some("claude-sonnet-4-5".into()),
                    input_tokens: Some(input_tokens),
                },
                parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
            },
        )
    }

    fn make_assistant_usage(
        session_id: &str,
        usage: RuntimeUsage,
        parent_tool_use_id: Option<&str>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(session_id.into()),
                usage: Some(usage),
                context_window: None,
                raw: json!({ "type": "usage_update" }),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Other],
                },
                parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
            },
        )
    }

    fn make_assistant_with_tool_use(
        session_id: &str,
        tool_use_id: &str,
        name: &str,
        usage: Option<RuntimeUsage>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(session_id.into()),
                usage,
                context_window: None,
                raw: json!({ "type": "assistant" }),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::ToolUse {
                        id: tool_use_id.into(),
                        name: name.into(),
                        input: json!({}),
                    }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    fn make_user_with_tool_result_with_parent(
        session_id: &str,
        tool_use_id: &str,
        parent_tool_use_id: Option<&str>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(session_id.into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "user" }),
            },
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: vec![RuntimeUserContentBlock::ToolResult {
                        tool_use_id: Some(tool_use_id.into()),
                        is_error: false,
                        content: json!("ok"),
                    }],
                },
                parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
            },
        )
    }

    fn make_user_with_tool_result(session_id: &str, tool_use_id: &str) -> RuntimeEvent {
        make_user_with_tool_result_with_parent(session_id, tool_use_id, None)
    }

    fn make_result_with_context_window(session_id: &str, context_window: u64) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(session_id.into()),
                usage: None,
                context_window: Some(context_window),
                raw: json!({ "type": "result" }),
            },
            RuntimeEventKind::Result,
        )
    }

    #[test]
    fn apply_event_updates_snapshot_for_root_session() {
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");

        let update = state.apply_event(None, &make_message_start("root-1", 1234, None));
        assert!(update.changed);
        assert_eq!(update.snapshot.input_tokens, 1234);

        let update = state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 5000,
                    output_tokens: 800,
                },
                None,
            ),
        );
        assert!(update.changed);
        assert_eq!(update.snapshot.input_tokens, 5000);
        assert_eq!(update.snapshot.output_tokens, 800);
    }

    #[test]
    fn apply_event_ignores_subagent_events_with_parent_tool_use_id() {
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 5000,
                    output_tokens: 800,
                },
                None,
            ),
        );
        let update = state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 999,
                    output_tokens: 111,
                },
                Some("toolu_abc"),
            ),
        );
        assert!(!update.changed);
        assert_eq!(update.snapshot.input_tokens, 5000);
    }

    #[test]
    fn apply_event_ignores_events_from_other_runtime_sessions() {
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 5000,
                    output_tokens: 800,
                },
                None,
            ),
        );
        let update = state.apply_event(
            None,
            &make_assistant_usage(
                "child-2",
                RuntimeUsage {
                    input_tokens: 222,
                    output_tokens: 33,
                },
                None,
            ),
        );
        assert!(!update.changed);
        assert_eq!(update.snapshot.input_tokens, 5000);
    }

    #[test]
    fn apply_event_accepts_all_events_before_root_is_known() {
        let mut state = RuntimeUsageState::new(None);
        let update = state.apply_event(None, &make_message_start("root-1", 42, None));
        assert!(update.changed);
        assert_eq!(update.snapshot.input_tokens, 42);
    }

    #[test]
    fn is_subagent_event_classifies_each_signal() {
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        assert!(!state.is_subagent_event(&make_message_start("root-1", 1, None)));
        assert!(state.is_subagent_event(&make_message_start("root-1", 1, Some("toolu_abc"),)));
        assert!(state.is_subagent_event(&make_message_start("child-2", 1, None)));
    }

    #[test]
    fn set_root_session_id_is_idempotent() {
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        state.set_root_session_id("child-2");
        let update = state.apply_event(
            None,
            &make_assistant_usage(
                "child-2",
                RuntimeUsage {
                    input_tokens: 999,
                    output_tokens: 111,
                },
                None,
            ),
        );
        assert!(!update.changed);
        assert_eq!(update.snapshot.input_tokens, 0);
    }

    // ── Active sub-agent window integration tests ────────────────────────

    #[test]
    fn task_tool_use_opens_subagent_window() {
        // Reproduces the production bug: a Claude Code Task sub-agent
        // streams a MessageStart with sub-agent input_tokens but no
        // parent_tool_use_id (CLI dropped it). The active-window fallback
        // must filter it.
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 5000,
                    output_tokens: 800,
                },
                None,
            ),
        );
        state.apply_event(
            None,
            &make_assistant_with_tool_use("root-1", "toolu_1", "Task", None),
        );
        let update = state.apply_event(None, &make_message_start("root-1", 150_000, None));
        assert!(!update.changed);
        assert_eq!(update.snapshot.input_tokens, 5000);
    }

    #[test]
    fn task_tool_result_closes_subagent_window() {
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        state.apply_event(
            None,
            &make_assistant_with_tool_use("root-1", "toolu_1", "Task", None),
        );
        let update = state.apply_event(None, &make_message_start("root-1", 150_000, None));
        assert!(!update.changed);

        state.apply_event(None, &make_user_with_tool_result("root-1", "toolu_1"));

        let update = state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 6000,
                    output_tokens: 900,
                },
                None,
            ),
        );
        assert!(update.changed);
        assert_eq!(update.snapshot.input_tokens, 6000);
        assert_eq!(update.snapshot.output_tokens, 900);
    }

    #[test]
    fn task_tool_result_with_parent_tool_use_id_still_closes_window() {
        // Some transcripts include parent_tool_use_id on the root tool_result
        // that closes a Task. We still must close the fallback window, or
        // later root events will be misclassified as sub-agent traffic.
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        state.apply_event(
            None,
            &make_assistant_with_tool_use("root-1", "toolu_1", "Task", None),
        );

        // While the window is active, leaked same-session events are filtered.
        let update = state.apply_event(None, &make_message_start("root-1", 150_000, None));
        assert!(!update.changed);

        // Close event includes parent_tool_use_id and should still close.
        state.apply_event(
            None,
            &make_user_with_tool_result_with_parent("root-1", "toolu_1", Some("toolu_1")),
        );

        let update = state.apply_event(
            None,
            &make_assistant_usage(
                "root-1",
                RuntimeUsage {
                    input_tokens: 6000,
                    output_tokens: 900,
                },
                None,
            ),
        );
        assert!(update.changed);
        assert_eq!(update.snapshot.input_tokens, 6000);
    }

    #[test]
    fn task_carrier_assistant_message_still_updates_root_snapshot() {
        // The very assistant message that emits the Task tool_use is itself
        // a root event and must update the snapshot when it carries usage.
        let mut state = RuntimeUsageState::new(None);
        state.set_root_session_id("root-1");
        let update = state.apply_event(
            None,
            &make_assistant_with_tool_use(
                "root-1",
                "toolu_1",
                "Task",
                Some(RuntimeUsage {
                    input_tokens: 4321,
                    output_tokens: 222,
                }),
            ),
        );
        assert!(update.changed);
        assert_eq!(update.snapshot.input_tokens, 4321);
        assert_eq!(update.snapshot.output_tokens, 222);
    }

    #[test]
    fn result_event_during_subagent_window_still_updates_context_window() {
        // The Result is the root turn boundary — its modelUsage.contextWindow
        // is authoritative for the root, even if a sub-agent window is open.
        let mut state = RuntimeUsageState::new(Some(200_000));
        state.set_root_session_id("root-1");
        state.apply_event(
            None,
            &make_assistant_with_tool_use("root-1", "toolu_1", "Task", None),
        );
        let update = state.apply_event(None, &make_result_with_context_window("root-1", 180_000));
        assert!(update.context_window_changed);
        assert_eq!(update.snapshot.context_window, Some(180_000));
    }

    // ── Provider flow integration tests ─────────────────────────────────
    //
    // These exercise the full sequence of events a real provider produces
    // when invoking a sub-agent. They protect against drift in the shared
    // `RuntimeUsageState` logic for both Claude Code (same session_id, may
    // drop parent_tool_use_id) and OpenCode (separate child session_id,
    // adapter sets parent_tool_use_id once the subtask is paired).

    #[test]
    fn claude_code_subagent_flow_protects_root_snapshot() {
        // Claude Code Task sub-agents share the parent's session_id. The
        // CLI sometimes drops `parent_tool_use_id` from sub-agent stream
        // events — only the SubagentWindow fallback prevents the leak.
        let mut state = RuntimeUsageState::new(Some(200_000));
        state.set_root_session_id("cc-root");

        // 1. Root MessageStart, then Assistant emits a Task tool_use
        //    (carrier message — must update the snapshot).
        let r = state.apply_event(None, &make_message_start("cc-root", 10_000, None));
        assert_eq!(r.snapshot.input_tokens, 10_000);
        let r = state.apply_event(
            None,
            &make_assistant_with_tool_use(
                "cc-root",
                "toolu_1",
                "Task",
                Some(RuntimeUsage {
                    input_tokens: 12_000,
                    output_tokens: 200,
                }),
            ),
        );
        assert_eq!(r.snapshot.input_tokens, 12_000);
        assert_eq!(r.snapshot.output_tokens, 200);

        // 2. Sub-agent well-behaved frame (parent_tool_use_id set) — caught
        //    by the existing first-line filter.
        let r = state.apply_event(
            None,
            &make_message_start("cc-root", 180_000, Some("toolu_1")),
        );
        assert!(!r.changed);
        let r = state.apply_event(
            None,
            &make_assistant_usage(
                "cc-root",
                RuntimeUsage {
                    input_tokens: 180_000,
                    output_tokens: 5_000,
                },
                Some("toolu_1"),
            ),
        );
        assert!(!r.changed);
        assert_eq!(r.snapshot.input_tokens, 12_000);

        // 3. Sub-agent LEAKED frame (CLI dropped parent_tool_use_id, same
        //    session) — only the SubagentWindow fallback catches this. This
        //    is the regression scenario we're fixing.
        let r = state.apply_event(None, &make_message_start("cc-root", 175_000, None));
        assert!(!r.changed);
        assert_eq!(r.snapshot.input_tokens, 12_000);

        // 4. Result during the window still updates context_window (root
        //    turn boundary is authoritative).
        let r = state.apply_event(None, &make_result_with_context_window("cc-root", 200_000));
        assert!(!r.context_window_changed); // already 200_000

        // 5. Tool result closes the window; root resumes.
        state.apply_event(None, &make_user_with_tool_result("cc-root", "toolu_1"));
        let r = state.apply_event(
            None,
            &make_assistant_usage(
                "cc-root",
                RuntimeUsage {
                    input_tokens: 13_500,
                    output_tokens: 350,
                },
                None,
            ),
        );
        assert!(r.changed);
        assert_eq!(r.snapshot.input_tokens, 13_500);
        assert_eq!(r.snapshot.output_tokens, 350);
    }

    #[test]
    fn opencode_subagent_flow_protects_root_snapshot() {
        // OpenCode child sub-agents get their OWN session_id (via
        // `Session.parent_id`) AND the OpenCode adapter sets
        // parent_tool_use_id once it pairs the subtask. Either signal is
        // enough to filter — verify both branches still hold even though
        // SubagentWindow also activates on the Task/Agent tool_use.
        let mut state = RuntimeUsageState::new(Some(200_000));
        state.set_root_session_id("oc-root");

        // 1. Root Assistant carries an Agent tool_use + its own usage.
        //    OpenCode maps `agent` → `RuntimeContentBlock::ToolUse{name:"Agent"}`.
        let r = state.apply_event(
            None,
            &make_assistant_with_tool_use(
                "oc-root",
                "toolu_oc",
                "Agent",
                Some(RuntimeUsage {
                    input_tokens: 8_000,
                    output_tokens: 150,
                }),
            ),
        );
        assert_eq!(r.snapshot.input_tokens, 8_000);

        // 2a. Child session frame WITHOUT parent_tool_use_id — caught by
        //     the session_id check (child session != root).
        let r = state.apply_event(None, &make_message_start("oc-child", 180_000, None));
        assert!(!r.changed);

        // 2b. Child session frame WITH parent_tool_use_id (after pairing) —
        //     caught by the first-line filter.
        let r = state.apply_event(
            None,
            &make_assistant_usage(
                "oc-child",
                RuntimeUsage {
                    input_tokens: 175_000,
                    output_tokens: 4_000,
                },
                Some("toolu_oc"),
            ),
        );
        assert!(!r.changed);
        assert_eq!(r.snapshot.input_tokens, 8_000);

        // 3. Tool result on the ROOT session closes the window.
        state.apply_event(None, &make_user_with_tool_result("oc-root", "toolu_oc"));

        // 4. Root resumes with new usage — must update.
        let r = state.apply_event(
            None,
            &make_assistant_usage(
                "oc-root",
                RuntimeUsage {
                    input_tokens: 9_500,
                    output_tokens: 250,
                },
                None,
            ),
        );
        assert!(r.changed);
        assert_eq!(r.snapshot.input_tokens, 9_500);
    }

    #[test]
    fn opencode_root_result_during_subagent_window_still_updates_context_window() {
        // Regression guard: the SubagentWindow fallback must not eat a
        // legitimate Result event from the OpenCode root turn even while a
        // child sub-agent is in flight (Result is exempted by design).
        let mut state = RuntimeUsageState::new(Some(200_000));
        state.set_root_session_id("oc-root");
        state.apply_event(
            None,
            &make_assistant_with_tool_use("oc-root", "toolu_oc", "Agent", None),
        );

        let r = state.apply_event(None, &make_result_with_context_window("oc-root", 175_000));
        assert!(r.context_window_changed);
        assert_eq!(r.snapshot.context_window, Some(175_000));
    }
}
