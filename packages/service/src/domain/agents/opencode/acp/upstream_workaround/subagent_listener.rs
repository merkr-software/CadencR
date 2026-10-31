//! REST polling listener for OpenCode sub-agent activity (upstream
//! issue sst/opencode#6573 — `Task`/`Agent` events never reach the ACP
//! wire). Polls `GET /session/{root}/children`, `/session/{child}/message`,
//! and `/permission` on the embedded HTTP backend.
//!
//! `prime_snapshot` runs eagerly so pre-existing children are not mispaired;
//! `surfaced_permissions` tracks currently pending permission ids. Each
//! child's snapshot also reports its sub-agent's status (`child_status`);
//! a finished child is retired so it is no longer polled.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use opencode_sdk_rs::{
    Message, MessagePart, MessageRole, OpenCodeClient, PendingPermission, Session,
};
use serde_json::json;
use tokio::sync::{mpsc, RwLock};

use super::child_status::{ChildReporter, ChildSnapshot};
use super::pending_subagents::{PendingSubagentState, PendingSubagentTasks};
use super::subagent_permission::{
    build_request, try_auto_allow_trusted_cadencr_browser_permission,
};
use crate::domain::agents::acp::runtime::permissions::permission_raw_event;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimePermissionRequest,
    RuntimeSubagentUpdate,
};
use crate::domain::agents::opencode::stream_synthesizer::StreamSynthesizer;

/// Pending-permissions map; the adapter's `respond_permission_fallback`
/// reads it to route a reply to `POST /permission/{id}/reply`.
pub type PermissionRegistry = Arc<RwLock<HashMap<String, RuntimePermissionRequest>>>;

pub(super) async fn poll_once(
    client: &OpenCodeClient,
    directory: &str,
    root_session_id: &str,
    state: &mut ListenerState,
    pending_tasks: &PendingSubagentTasks,
    permissions: &PermissionRegistry,
    runtime_tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<(), ()> {
    match client
        .list_children_in_directory(root_session_id, Some(directory))
        .await
    {
        Ok(children) => state.absorb_children(&children, pending_tasks),
        Err(error) => {
            tracing::debug!(%error, "OpenCode sub-agent listener: list_children failed")
        }
    }
    for child_id in state.known_children() {
        if poll_child_messages(
            client,
            directory,
            &child_id,
            state,
            pending_tasks,
            runtime_tx,
        )
        .await
        .is_err()
        {
            return Err(());
        }
    }
    poll_permissions(client, directory, state, permissions, runtime_tx).await
}

async fn poll_child_messages(
    client: &OpenCodeClient,
    directory: &str,
    child_id: &str,
    state: &mut ListenerState,
    pending_tasks: &PendingSubagentTasks,
    runtime_tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<(), ()> {
    let messages = match client.list_messages(child_id, Some(directory)).await {
        Ok(messages) => messages,
        Err(error) => {
            tracing::debug!(%error, child = %child_id, "OpenCode sub-agent listener: list_messages failed");
            return Ok(());
        }
    };
    let mut events: Vec<RuntimeEvent> = messages
        .iter()
        .flat_map(|message| state.handle_message(message))
        .collect();
    events.extend(state.report_child(child_id, &messages, pending_tasks, Instant::now()));
    for event in events {
        if runtime_tx.send(Ok(event)).await.is_err() {
            return Err(());
        }
    }
    Ok(())
}

async fn poll_permissions(
    client: &OpenCodeClient,
    directory: &str,
    state: &mut ListenerState,
    permissions: &PermissionRegistry,
    runtime_tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<(), ()> {
    let entries = match client.list_permissions(Some(directory)).await {
        Ok(entries) => entries,
        Err(error) => {
            tracing::debug!(%error, "OpenCode sub-agent listener: list_permissions failed");
            return Ok(());
        }
    };
    state.prune_surfaced_permissions(&entries);
    for entry in entries {
        if try_auto_allow_trusted_cadencr_browser_permission(client, directory, &entry).await {
            continue;
        }
        if let Some(event) = state.surface_permission(entry, permissions).await {
            if runtime_tx.send(Ok(event)).await.is_err() {
                return Err(());
            }
        }
    }
    Ok(())
}

pub(super) struct ListenerState {
    root_session_id: String,
    /// Baseline of pre-existing children; `None` until `prime_snapshot` runs.
    historical_children: Option<HashSet<String>>,
    child_to_parent: HashMap<String, String>,
    synthesizers: HashMap<String, StreamSynthesizer>,
    surfaced_permissions: HashSet<String>,
    reporters: HashMap<String, ChildReporter>,
    /// Finished children, no longer polled, with how many messages they held
    /// then. One re-registers only through an explicit `task_id` binding (a
    /// resumed task), never by FIFO.
    retired: HashMap<String, usize>,
    /// Resumed children whose new run has not started yet: their transcript
    /// still ends on the previous run until the new prompt lands.
    resumed_at: HashMap<String, usize>,
}

impl ListenerState {
    pub(super) fn new(root_session_id: String) -> Self {
        Self {
            root_session_id,
            historical_children: None,
            child_to_parent: HashMap::new(),
            synthesizers: HashMap::new(),
            surfaced_permissions: HashSet::new(),
            reporters: HashMap::new(),
            retired: HashMap::new(),
            resumed_at: HashMap::new(),
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.child_to_parent.is_empty()
    }
    fn known_children(&self) -> Vec<String> {
        self.child_to_parent.keys().cloned().collect()
    }

    /// Capture pre-existing children. MUST run before `absorb_children`,
    /// else this turn's new sub-agents are mispaired.
    pub(super) fn prime_snapshot(&mut self, children: &[Session]) {
        let baseline: HashSet<String> = children
            .iter()
            .filter(|s| s.parent_id.as_deref() == Some(self.root_session_id.as_str()))
            .map(|s| s.id.clone())
            .collect();
        tracing::info!(root = %self.root_session_id, historical = baseline.len(), "OpenCode sub-agent listener: primed historical-children snapshot");
        self.historical_children = Some(baseline);
    }

    fn absorb_children(&mut self, children: &[Session], pending_tasks: &PendingSubagentTasks) {
        for session in children {
            self.maybe_register_child(session, pending_tasks);
        }
    }

    fn maybe_register_child(&mut self, session: &Session, pending_tasks: &PendingSubagentTasks) {
        if session.parent_id.as_deref() != Some(self.root_session_id.as_str()) {
            return;
        }
        let historical = self
            .historical_children
            .as_ref()
            .expect("prime_snapshot must run before absorb_children");
        if historical.contains(&session.id) || self.child_to_parent.contains_key(&session.id) {
            return;
        }
        let retired = self.retired.contains_key(&session.id);
        let claimed = with_pending(pending_tasks, |pending| {
            if retired {
                pending.take_bound_for_child(&session.id)
            } else {
                pending.take_for_child(&session.id)
            }
        })
        .flatten();
        let parent_tool_use_id = match claimed {
            Some(id) => id,
            None if retired => return,
            None => {
                tracing::warn!(child = %session.id, "OpenCode sub-agent listener: child session has no pending Task call_id to pair with");
                return;
            }
        };
        if let Some(message_count) = self.retired.remove(&session.id) {
            self.resumed_at.insert(session.id.clone(), message_count);
        }
        with_pending(pending_tasks, |pending| {
            pending.mark_tailed(&parent_tool_use_id)
        });
        tracing::info!(child = %session.id, %parent_tool_use_id, "OpenCode sub-agent listener: registered child");
        self.child_to_parent
            .insert(session.id.clone(), parent_tool_use_id);
    }

    fn handle_message(&mut self, message: &Message) -> Vec<RuntimeEvent> {
        if !matches!(message.role, MessageRole::Assistant) {
            return Vec::new();
        }
        let Some(parent_tool_use_id) = self.child_to_parent.get(&message.session_id).cloned()
        else {
            return Vec::new();
        };
        let synth = self
            .synthesizers
            .entry(message.session_id.clone())
            .or_insert_with(|| StreamSynthesizer::new(message.model.clone()));
        let mut output = Vec::new();
        for part in &message.parts {
            if matches!(part, MessagePart::StepFinish { .. } | MessagePart::Other(_)) {
                continue;
            }
            output.extend(synth.ingest_part(
                &message.session_id,
                part,
                Some(parent_tool_use_id.as_str()),
            ));
        }
        output
    }

    /// What the child's snapshot says about its sub-agent, throttled; retires
    /// the child once it finished.
    fn report_child(
        &mut self,
        child_id: &str,
        messages: &[Message],
        pending_tasks: &PendingSubagentTasks,
        now: Instant,
    ) -> Option<RuntimeEvent> {
        let tool_use_id = self.child_to_parent.get(child_id)?.clone();
        if !self.resumed_run_started(child_id, messages.len()) {
            return None;
        }
        let snapshot = ChildSnapshot::read(messages);
        let background = with_pending(pending_tasks, |pending| pending.is_background(&tool_use_id))
            .unwrap_or(false);
        let finished = snapshot.is_finished();
        let patch = self
            .reporters
            .entry(child_id.to_string())
            .or_default()
            .next(snapshot.patch(child_id, background), finished, now);
        if finished {
            self.child_to_parent.remove(child_id);
            self.reporters.remove(child_id);
            self.retired.insert(child_id.to_string(), messages.len());
            with_pending(pending_tasks, |pending| {
                pending.forget_background(&tool_use_id)
            });
            tracing::info!(child = %child_id, %tool_use_id, "OpenCode sub-agent listener: retired finished child");
        }
        patch.map(|patch| {
            RuntimeEvent::subagent_signal(vec![RuntimeSubagentUpdate::new(tool_use_id, patch)])
        })
    }

    /// False while a resumed child still holds only its previous run, whose
    /// end must not retire it again (and lose the new run's report).
    fn resumed_run_started(&mut self, child_id: &str, message_count: usize) -> bool {
        match self.resumed_at.get(child_id) {
            Some(&previous) if message_count <= previous => false,
            Some(_) => {
                self.resumed_at.remove(child_id);
                true
            }
            None => true,
        }
    }

    /// Drop dedupe ids no longer pending upstream — bounds the set.
    fn prune_surfaced_permissions(&mut self, live: &[PendingPermission]) {
        let live_ids: HashSet<&str> = live.iter().map(|p| p.id.as_str()).collect();
        self.surfaced_permissions
            .retain(|id| live_ids.contains(id.as_str()));
    }

    async fn surface_permission(
        &mut self,
        entry: PendingPermission,
        permissions: &PermissionRegistry,
    ) -> Option<RuntimeEvent> {
        if self.surfaced_permissions.contains(&entry.id) {
            return None;
        }
        if entry.session_id == self.root_session_id {
            // Root-session permissions still flow through the ACP wire.
            self.surfaced_permissions.insert(entry.id);
            return None;
        }
        let parent_tool_use_id = self.child_to_parent.get(&entry.session_id).cloned()?;
        self.surfaced_permissions.insert(entry.id.clone());
        let request = build_request(&entry);
        permissions
            .write()
            .await
            .insert(entry.id.clone(), request.clone());
        let acp_params = json!({ "transport": "opencode_http", "permission_id": entry.id });
        let metadata = RuntimeEventMetadata {
            session_id: Some(entry.session_id),
            raw: permission_raw_event(&request, &acp_params),
            ..RuntimeEventMetadata::default()
        };
        let mut event = RuntimeEvent::new(metadata, RuntimeEventKind::Other);
        event.set_parent_tool_use_id(Some(parent_tool_use_id));
        Some(event)
    }
}

fn with_pending<R>(
    pending_tasks: &PendingSubagentTasks,
    apply: impl FnOnce(&mut PendingSubagentState) -> R,
) -> Option<R> {
    match pending_tasks.lock() {
        Ok(mut pending) => Some(apply(&mut pending)),
        Err(error) => {
            tracing::error!(%error, "OpenCode pending sub-agent state is poisoned");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ListenerState, PendingSubagentState, PendingSubagentTasks, PermissionRegistry};
    use opencode_sdk_rs::{
        Message, MessagePart, MessageRole, PendingPermission, Session, SessionStatus,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::sync::RwLock;

    fn pending(ids: &[&str]) -> PendingSubagentTasks {
        let mut state = PendingSubagentState::default();
        for id in ids {
            state.push_tool_call((*id).to_string());
        }
        Arc::new(Mutex::new(state))
    }
    fn registry() -> PermissionRegistry {
        Arc::new(RwLock::new(HashMap::new()))
    }
    fn child(id: &str, parent: &str) -> Session {
        Session {
            id: id.into(),
            title: None,
            directory: "/tmp".into(),
            status: SessionStatus::Active,
            parent_id: Some(parent.into()),
            created_at: None,
            updated_at: None,
        }
    }
    fn asst_text(sess: &str, text: &str) -> Message {
        Message {
            id: "m".into(),
            session_id: sess.into(),
            role: MessageRole::Assistant,
            parts: vec![MessagePart::Text {
                id: "p".into(),
                text: text.into(),
            }],
            created_at: None,
            model: None,
            tokens: None,
            finished: false,
            completed_at: None,
            finish: None,
            error: None,
            variant: None,
            error_name: None,
        }
    }
    fn perm(id: &str, session: &str) -> PendingPermission {
        PendingPermission {
            id: id.into(),
            session_id: session.into(),
            tool: Some("bash".into()),
            title: None,
            call_id: None,
            message_id: None,
            patterns: vec!["ls".into()],
            metadata: json!({}),
        }
    }
    fn primed_state() -> (ListenerState, PendingSubagentTasks) {
        let (mut state, queue) = (ListenerState::new("root".into()), pending(&[]));
        state.prime_snapshot(&[]);
        (state, queue)
    }

    #[test]
    fn prime_snapshot_records_baseline_then_absorb_pairs_new_children_fifo() {
        let mut state = ListenerState::new("root".into());
        let queue = pending(&["call_a", "call_b"]);
        state.prime_snapshot(&[child("ses_old", "root"), child("not_mine", "other_root")]);
        assert!(state.child_to_parent.is_empty());
        assert!(!queue.lock().unwrap().is_empty());
        let after = [
            child("ses_old", "root"),
            child("ses_new_1", "root"),
            child("ses_new_2", "root"),
        ];
        state.absorb_children(&after, &queue);
        assert_eq!(state.child_to_parent.get("ses_new_1").unwrap(), "call_a");
        assert_eq!(state.child_to_parent.get("ses_new_2").unwrap(), "call_b");
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn session_id_binding_wins_over_fifo_order() {
        let mut state = ListenerState::new("root".into());
        let queue = pending(&["call_first", "call_second"]);
        state.prime_snapshot(&[]);
        queue
            .lock()
            .unwrap()
            .bind_child_session("ses_b", "call_second");
        state.absorb_children(&[child("ses_b", "root"), child("ses_a", "root")], &queue);
        assert_eq!(state.child_to_parent.get("ses_b").unwrap(), "call_second");
        assert_eq!(state.child_to_parent.get("ses_a").unwrap(), "call_first");
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn bind_after_fifo_consume_does_not_orphan_mapping() {
        let mut state = ListenerState::new("root".into());
        let queue = pending(&["call_a"]);
        state.prime_snapshot(&[]);
        state.absorb_children(&[child("ses_a", "root")], &queue);
        assert!(queue.lock().unwrap().is_empty());
        // Late task_id update must not re-insert a consumed tool call.
        queue.lock().unwrap().bind_child_session("ses_a", "call_a");
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn bind_is_idempotent_for_identical_mapping() {
        let queue = pending(&["call_a"]);
        {
            let mut pending = queue.lock().unwrap();
            pending.bind_child_session("ses_a", "call_a");
            pending.bind_child_session("ses_a", "call_a");
            assert!(!pending.is_empty());
            assert_eq!(pending.take_for_child("ses_a").as_deref(), Some("call_a"));
            assert!(pending.is_empty());
        }
    }

    #[test]
    fn registration_is_idempotent_and_ignores_wrong_or_missing_parent() {
        let (mut state, queue) = primed_state();
        queue.lock().unwrap().push_tool_call("call_a".into());
        state.absorb_children(&[child("ses_child", "root")], &queue);
        state.absorb_children(&[child("ses_child", "root")], &queue);
        assert_eq!(state.child_to_parent.len(), 1);
        let mut loose = child("loose", "root");
        loose.parent_id = None;
        state.absorb_children(&[loose, child("other", "different_root")], &queue);
        assert_eq!(state.child_to_parent.len(), 1);
    }

    #[test]
    fn handles_assistant_message_deltas_for_known_child_only() {
        let (mut state, queue) = primed_state();
        queue.lock().unwrap().push_tool_call("call_task".into());
        state.absorb_children(&[child("ses_child", "root")], &queue);
        let first = state.handle_message(&asst_text("ses_child", "Hello"));
        let second = state.handle_message(&asst_text("ses_child", "Hello world"));
        assert!(!first.is_empty());
        assert_eq!(second.len(), 1, "second poll must emit only the delta");
        assert!(first
            .iter()
            .all(|e| e.parent_tool_use_id() == Some("call_task")));
        assert!(state
            .handle_message(&asst_text("ses_unknown", "stray"))
            .is_empty());
    }

    fn finished_asst(sess: &str, text: &str) -> Message {
        let mut message = asst_text(sess, text);
        message.model = Some("anthropic/claude-haiku-5-5".into());
        message.finish = Some("stop".into());
        message.finished = true;
        message
    }

    #[test]
    fn running_child_reports_its_session_and_model() {
        let (mut state, queue) = primed_state();
        queue.lock().unwrap().push_tool_call("call_task".into());
        state.absorb_children(&[child("ses_child", "root")], &queue);
        let mut message = asst_text("ses_child", "Working");
        message.model = Some("openai/gpt-6.1".into());
        let event = state
            .report_child("ses_child", &[message], &queue, std::time::Instant::now())
            .expect("report");
        assert!(event.is_subagent_signal_only());
        let update = &event.subagent_updates()[0];
        assert_eq!(update.tool_use_id, "call_task");
        assert_eq!(update.patch.child_session_id.as_deref(), Some("ses_child"));
        assert_eq!(update.patch.model.as_deref(), Some("openai/gpt-6.1"));
        assert_eq!(update.patch.status, None);
        assert!(!state.is_empty(), "still polled while running");
        assert!(
            queue.lock().unwrap().take_tailed("call_task"),
            "the listener owns the child's transcript"
        );
    }

    #[test]
    fn finished_background_child_completes_and_is_retired() {
        let (mut state, queue) = primed_state();
        queue.lock().unwrap().push_tool_call("call_bg".into());
        queue.lock().unwrap().mark_background("call_bg");
        state.absorb_children(&[child("ses_bg", "root")], &queue);
        let event = state
            .report_child(
                "ses_bg",
                &[finished_asst("ses_bg", "Report")],
                &queue,
                std::time::Instant::now(),
            )
            .expect("report");
        let patch = &event.subagent_updates()[0].patch;
        assert_eq!(
            patch.status,
            Some(crate::domain::agents::adapter::RuntimeSubagentStatus::Completed)
        );
        assert_eq!(patch.result_summary.as_deref(), Some("Report"));
        assert!(state.is_empty(), "a finished child is no longer polled");
        assert!(!queue.lock().unwrap().is_background("call_bg"));
    }

    #[test]
    fn retired_child_reregisters_only_through_an_explicit_binding() {
        let (mut state, queue) = primed_state();
        queue.lock().unwrap().push_tool_call("call_first".into());
        state.absorb_children(&[child("ses_done", "root")], &queue);
        let finished = [finished_asst("ses_done", "Done")];
        let event = state
            .report_child("ses_done", &finished, &queue, std::time::Instant::now())
            .expect("report");
        // Foreground: the parent's task update settles the status, and must
        // still know the listener streamed the report.
        assert_eq!(event.subagent_updates()[0].patch.status, None);
        assert!(state.is_empty());
        assert!(queue.lock().unwrap().take_tailed("call_first"));
        // A new, unrelated Task must not be stolen by the finished child.
        queue.lock().unwrap().push_tool_call("call_next".into());
        state.absorb_children(&[child("ses_done", "root")], &queue);
        assert!(state.is_empty());
        // Resumed with `task_id`: the explicit binding re-registers it.
        queue
            .lock()
            .unwrap()
            .bind_child_session("ses_done", "call_next");
        state.absorb_children(&[child("ses_done", "root")], &queue);
        assert_eq!(state.child_to_parent.get("ses_done").unwrap(), "call_next");
        // Polled before its new prompt lands, it still ends on its first run:
        // that end must not retire it, or the new run and its report are lost.
        let now = std::time::Instant::now();
        assert!(state
            .report_child("ses_done", &finished, &queue, now)
            .is_none());
        assert!(!state.is_empty());
        let mut prompt = asst_text("ses_done", "Again");
        prompt.role = MessageRole::User;
        let resumed = [
            finished[0].clone(),
            prompt,
            finished_asst("ses_done", "Again done"),
        ];
        assert!(state
            .report_child("ses_done", &resumed[..2], &queue, now)
            .is_some());
        assert!(!state.is_empty());
        state.report_child("ses_done", &resumed, &queue, now);
        assert!(state.is_empty());
        assert!(queue.lock().unwrap().take_tailed("call_next"));
    }

    #[tokio::test]
    async fn surface_permission_handles_known_dedupe_root_unknown_pair_and_prune() {
        let (mut state, queue) = primed_state();
        queue.lock().unwrap().push_tool_call("call_task_1".into());
        state.absorb_children(&[child("ses_child", "root")], &queue);
        let reg = registry();
        // Known child → event stamped with parent_tool_use_id + registry entry.
        let event = state
            .surface_permission(perm("per_1", "ses_child"), &reg)
            .await
            .expect("event");
        let raw = event.raw_json();
        assert_eq!(raw["request_id"], "per_1");
        assert_eq!(raw["tool_name"], "Bash");
        assert_eq!(raw["parent_tool_use_id"], "call_task_1");
        assert!(reg.read().await.contains_key("per_1"));
        // Dedupe across re-polls.
        assert!(state
            .surface_permission(perm("per_1", "ses_child"), &reg)
            .await
            .is_none());
        // Live list no longer mentions per_1 → prune drops the dedupe entry.
        state.prune_surfaced_permissions(&[]);
        assert!(state.surfaced_permissions.is_empty());
        // Root-session permission flows over ACP wire — skipped.
        let mut root = ListenerState::new("root".into());
        assert!(root
            .surface_permission(perm("p_r", "root"), &reg)
            .await
            .is_none());
        // Unknown child does NOT mark surfaced — emits once paired.
        let (mut s, q) = primed_state();
        assert!(s
            .surface_permission(perm("per_x", "ses_late"), &reg)
            .await
            .is_none());
        q.lock().unwrap().push_tool_call("call_late".into());
        s.absorb_children(&[child("ses_late", "root")], &q);
        assert!(s
            .surface_permission(perm("per_x", "ses_late"), &reg)
            .await
            .is_some());
    }
}
