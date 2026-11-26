//! Emit ACP `user_message_chunk` receipts when Antigravity delivers a queued
//! prompt into the root session's native transcript.
//!
//! `agy acp` accepts concurrent `session/prompt` steering requests, but does
//! not emit `user_message_chunk` and holds the active `session/prompt` RPC open
//! until the entire turn ends (or another steer supersedes it). Tailing the
//! root session's `transcript_full.jsonl` while a tracked prompt is pending
//! lets Cadencr clear "Not received by agent yet..." as soon as the agent
//! actually ingests the follow-up.

mod tracker;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub(crate) use self::tracker::ReceiptTracker;
use super::{request_id, session_update, validated_session_id};
use crate::events::subagents::parent_transcript;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReceiptOperation {
    Watch {
        session: String,
        watch_id: u64,
        baseline_len: Option<u64>,
    },
    Stop(String),
    Closed(String),
}

#[derive(Debug)]
pub(crate) struct ObservedUserInput {
    pub(crate) session: String,
    pub(crate) watch_id: u64,
    pub(crate) text: String,
    pub(crate) truncated: bool,
}

#[derive(Default)]
pub(super) struct PromptReceipts {
    brain: Option<PathBuf>,
    next_watch_id: u64,
    sessions: HashMap<String, SessionReceipts>,
    operations: Vec<ReceiptOperation>,
}

enum WatchState {
    Unwatched { baseline_len: u64 },
    Paused { baseline_len: Option<u64> },
    Watching,
}

struct SessionReceipts {
    active_rpcs: HashSet<String>,
    queue: VecDeque<PendingPrompt>,
    watch_id: u64,
    watch: WatchState,
}

struct PendingPrompt {
    rpc_id: String,
    client_message_id: Option<String>,
    expected_text: String,
    has_non_text_blocks: bool,
    settled: bool,
}

impl PromptReceipts {
    pub(super) fn with_brain(brain: Option<PathBuf>) -> Self {
        Self {
            brain,
            ..Self::default()
        }
    }

    pub(super) fn observe_request(&mut self, message: &Value) {
        if self.brain.is_none() {
            return;
        }
        match message.get("method").and_then(Value::as_str) {
            Some("$/cancel_request") => {
                if let Some(rpc_id) = request_id(message.pointer("/params/requestId")) {
                    self.finish_prompt_id(&rpc_id, false);
                }
            }
            Some("session/prompt") => {
                if let Some(session_id) = validated_session_id(message) {
                    self.observe_prompt(session_id, message);
                }
            }
            Some("session/load" | "session/resume" | "session/close") => {
                if let Some(session_id) = validated_session_id(message) {
                    self.remove_session(session_id);
                }
            }
            _ => {}
        }
    }

    pub(super) fn observe_update(&mut self, message: &Value) {
        if self.sessions.is_empty() {
            return;
        }
        let Some(update) = message.pointer("/params/update") else {
            return;
        };
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("user_message_chunk") {
            return;
        }
        let Some(session_id) = message.pointer("/params/sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(session) = self.sessions.get_mut(session_id) else {
            return;
        };
        // Match client messageId first (even if settled) so duplicates cannot fall
        // through; fall back to text only for omitted/provider-generated ids.
        let idx = update
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .and_then(|id| {
                session
                    .queue
                    .iter()
                    .position(|p| p.client_message_id.as_deref() == Some(id))
            })
            .or_else(|| {
                let text = normalize_text(update.pointer("/content/text")?.as_str()?);
                (!text.is_empty()).then(|| {
                    session
                        .queue
                        .iter()
                        .position(|p| !p.settled && p.expected_text == text)
                })?
            });
        if let Some(idx) = idx {
            session.queue[idx].settled = true;
            if session.stop_if_idle() {
                self.operations
                    .push(ReceiptOperation::Stop(session_id.to_owned()));
            }
        }
    }

    pub(super) fn observe_response(&mut self, message: &Value) {
        if self.sessions.is_empty() {
            return;
        }
        let Some(rpc_id) = request_id(message.get("id")) else {
            return;
        };
        let accepted = message.get("error").is_none()
            && message
                .pointer("/result/stopReason")
                .and_then(Value::as_str)
                .is_some_and(|reason| reason != "cancelled");
        self.finish_prompt_id(&rpc_id, accepted);
    }

    pub(super) fn observe_user_input(&mut self, input: ObservedUserInput) -> Option<Value> {
        let session = self.sessions.get_mut(&input.session)?;
        if session.watch_id != input.watch_id {
            return None;
        }
        let normalized = normalize_text(&input.text);
        let idx = session.match_prompt(&normalized, input.truncated)?;
        let prompt = session.queue.remove(idx)?;
        if session.stop_if_idle() {
            self.operations
                .push(ReceiptOperation::Stop(input.session.clone()));
        }
        if prompt.settled {
            return None;
        }
        let message_id = prompt.client_message_id?;
        Some(session_update(
            &input.session,
            json!({
                "sessionUpdate": "user_message_chunk",
                "messageId": message_id,
                "content": { "type": "text", "text": input.text },
            }),
        ))
    }

    pub(super) fn take_operations(&mut self) -> Vec<ReceiptOperation> {
        std::mem::take(&mut self.operations)
    }

    fn observe_prompt(&mut self, session_id: &str, message: &Value) {
        let Some(rpc_id) = request_id(message.get("id")) else {
            return;
        };
        let client_message_id = message
            .pointer("/params/messageId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
        let (expected_text, has_non_text_blocks) =
            extract_prompt(message.pointer("/params/prompt"));
        let brain = self.brain.as_deref();
        let session = if let Some(session) = self.sessions.get_mut(session_id) {
            // If all earlier prompts in the turn were already matched and the
            // watcher is paused, jump past any intervening tool output in O(1).
            if session.queue.is_empty() && matches!(session.watch, WatchState::Paused { .. }) {
                session.watch = WatchState::Paused {
                    baseline_len: Some(transcript_len(brain, session_id)),
                };
            }
            session
        } else {
            self.next_watch_id += 1;
            let baseline_len = transcript_len(brain, session_id);
            self.sessions
                .entry(session_id.to_owned())
                .or_insert(SessionReceipts {
                    active_rpcs: HashSet::new(),
                    queue: VecDeque::new(),
                    watch_id: self.next_watch_id,
                    watch: WatchState::Unwatched { baseline_len },
                })
        };
        session.active_rpcs.insert(rpc_id.clone());
        session.queue.push_back(PendingPrompt {
            rpc_id,
            client_message_id,
            expected_text,
            has_non_text_blocks,
            settled: false,
        });
        if session.has_unsettled_tracked() {
            if let Some(baseline_len) = session.start_watching() {
                self.operations.push(ReceiptOperation::Watch {
                    session: session_id.to_owned(),
                    watch_id: session.watch_id,
                    baseline_len,
                });
            }
        }
    }

    fn finish_prompt_id(&mut self, rpc_id: &str, accepted: bool) {
        let Some((session_id, session)) = self
            .sessions
            .iter_mut()
            .find_map(|(id, session)| session.active_rpcs.remove(rpc_id).then_some((id, session)))
        else {
            return;
        };
        if let Some(idx) = session
            .queue
            .iter()
            .position(|prompt| prompt.rpc_id == rpc_id)
        {
            if accepted {
                session.queue[idx].settled = true;
            } else {
                session.queue.remove(idx);
            }
        }
        let session_id = session_id.clone();
        if session.active_rpcs.is_empty() {
            self.remove_session(&session_id);
        } else if session.stop_if_idle() {
            self.operations.push(ReceiptOperation::Stop(session_id));
        }
    }

    fn remove_session(&mut self, session_id: &str) {
        if let Some(session) = self.sessions.remove(session_id) {
            if !matches!(session.watch, WatchState::Unwatched { .. }) {
                self.operations
                    .push(ReceiptOperation::Closed(session_id.to_owned()));
            }
        }
    }
}

impl SessionReceipts {
    fn has_unsettled_tracked(&self) -> bool {
        self.queue
            .iter()
            .any(|prompt| !prompt.settled && prompt.client_message_id.is_some())
    }

    fn start_watching(&mut self) -> Option<Option<u64>> {
        match self.watch {
            WatchState::Unwatched { baseline_len } => {
                self.watch = WatchState::Watching;
                Some(Some(baseline_len))
            }
            WatchState::Paused { baseline_len } => {
                self.watch = WatchState::Watching;
                Some(baseline_len)
            }
            WatchState::Watching => None,
        }
    }

    fn stop_if_idle(&mut self) -> bool {
        if matches!(self.watch, WatchState::Watching) && !self.has_unsettled_tracked() {
            self.watch = WatchState::Paused { baseline_len: None };
            return true;
        }
        false
    }

    fn match_prompt(&self, observed_text: &str, truncated: bool) -> Option<usize> {
        if observed_text.is_empty() {
            return self
                .queue
                .front()
                .is_some_and(|prompt| prompt.expected_text.is_empty())
                .then_some(0);
        }
        if let Some(idx) = self
            .queue
            .iter()
            .position(|prompt| prompt.matches_exact(observed_text, truncated))
        {
            return Some(idx);
        }
        if !truncated {
            let matches_front = self.queue.front().is_some_and(|prompt| {
                prompt.has_non_text_blocks
                    && !prompt.expected_text.is_empty()
                    && observed_text.contains(&prompt.expected_text)
            });
            if matches_front {
                return Some(0);
            }
        }
        None
    }
}

impl PendingPrompt {
    fn matches_exact(&self, observed_text: &str, truncated: bool) -> bool {
        !self.expected_text.is_empty()
            && if truncated {
                self.expected_text.starts_with(observed_text)
            } else {
                self.expected_text == observed_text
            }
    }
}

fn transcript_len(brain: Option<&Path>, session_id: &str) -> u64 {
    brain
        .and_then(|brain| parent_transcript(brain, session_id))
        .and_then(|path| fs::symlink_metadata(path).ok())
        .filter(|metadata| metadata.is_file())
        .map_or(0, |metadata| metadata.len())
}

/// Antigravity concatenates adjacent text blocks without inserting newlines.
fn extract_prompt(prompt: Option<&Value>) -> (String, bool) {
    let Some(blocks) = prompt.and_then(Value::as_array) else {
        return (String::new(), false);
    };
    let mut text = Cow::Borrowed("");
    let mut has_non_text = false;
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            has_non_text = true;
            continue;
        }
        let Some(chunk) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        if text.is_empty() {
            text = Cow::Borrowed(chunk);
        } else {
            text.to_mut().push_str(chunk);
        }
    }
    (normalize_text(&text), has_non_text)
}

fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::time::Duration;

    use super::tracker::extract_user_request_text;
    use super::*;

    const SESSION: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

    fn harness() -> (tempfile::TempDir, PathBuf, PromptReceipts, ReceiptTracker) {
        let temp = tempfile::tempdir().unwrap();
        let brain = temp.path().to_path_buf();
        let logs = brain.join(SESSION).join(".system_generated/logs");
        fs::create_dir_all(&logs).unwrap();
        let transcript = logs.join("transcript_full.jsonl");
        let receipts = PromptReceipts::with_brain(Some(brain.clone()));
        let tracker = ReceiptTracker::with_brain(Some(brain));
        (temp, transcript, receipts, tracker)
    }

    fn prompt_req(id: u64, message_id: Option<&str>, blocks: Value) -> Value {
        let mut params = json!({ "sessionId": SESSION, "prompt": blocks });
        if let Some(message_id) = message_id {
            params["messageId"] = json!(message_id);
        }
        json!({ "jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": params })
    }

    fn text_blocks(text: &str) -> Value {
        json!([{ "type": "text", "text": text }])
    }

    fn append_user_input(path: &Path, step_index: u64, request: &str) {
        let row = json!({
            "step_index": step_index,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "status": "DONE",
            "content": format!("<USER_REQUEST>\n{request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>"),
        });
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{row}").unwrap();
    }

    #[test]
    fn emits_user_message_chunk_as_soon_as_steer_reaches_transcript() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();

        receipts.observe_request(&prompt_req(10, None, text_blocks("Run step 1")));
        assert!(receipts.take_operations().is_empty());
        assert!(!tracker.is_watching());
        append_user_input(&transcript, 0, "Run step 1");

        // Steer arrives while step 1 runs; agy immediately settles id=10.
        receipts.observe_request(&prompt_req(
            11,
            Some("steer-uuid"),
            text_blocks("Also do step 2"),
        ));
        receipts.observe_response(&json!({ "id": 10, "result": { "stopReason": "end_turn" } }));
        let ops = receipts.take_operations();
        assert_eq!(ops.len(), 1);

        // Step 0 belongs to P1 (untracked) -> consumed, no user_message_chunk yet.
        let inputs = tracker.poll(ops);
        assert_eq!(inputs.len(), 1);
        assert!(receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .is_none());
        assert!(tracker.is_watching());

        // Step 1 finishes and agy ingests the steer into transcript_full.jsonl.
        append_user_input(&transcript, 3, "Also do step 2");
        let inputs = tracker.poll(receipts.take_operations());
        assert_eq!(inputs.len(), 1);
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("steer receipt");
        assert_eq!(frame["method"], "session/update");
        assert_eq!(frame["params"]["sessionId"], SESSION);
        assert_eq!(
            frame["params"]["update"]["sessionUpdate"],
            "user_message_chunk"
        );
        assert_eq!(frame["params"]["update"]["messageId"], "steer-uuid");
        assert_eq!(
            frame["params"]["update"]["content"]["text"],
            "Also do step 2"
        );

        // Tracker goes idle immediately once Stop is applied, and drops session on turn end.
        assert!(tracker.poll(receipts.take_operations()).is_empty());
        assert!(!tracker.is_watching());
        receipts.observe_response(&json!({ "id": 11, "result": { "stopReason": "end_turn" } }));
        tracker.apply_operations(receipts.take_operations());
        assert_eq!(tracker.tracked_session_count(), 0);
    }

    #[test]
    fn duplicate_text_between_initial_prompt_and_steer_does_not_false_ack() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();

        receipts.observe_request(&prompt_req(1, None, text_blocks("continue")));
        append_user_input(&transcript, 0, "continue");
        receipts.observe_request(&prompt_req(2, Some("m2"), text_blocks("continue")));
        receipts.observe_response(&json!({ "id": 1, "result": { "stopReason": "end_turn" } }));

        for input in tracker.poll(receipts.take_operations()) {
            assert!(receipts.observe_user_input(input).is_none());
        }
        assert!(tracker.is_watching());

        append_user_input(&transcript, 3, "continue");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("m2 receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "m2");
    }

    #[test]
    fn stale_in_flight_poll_from_previous_turn_cannot_false_ack_next_turn() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();

        receipts.observe_request(&prompt_req(1, None, text_blocks("step 1")));
        receipts.observe_request(&prompt_req(2, Some("m1"), text_blocks("continue")));
        receipts.observe_response(&json!({ "id": 1, "result": { "stopReason": "end_turn" } }));
        append_user_input(&transcript, 3, "continue");

        // Poll runs on blocking pool and reads Turn 1's "continue"...
        let stale_inputs = tracker.poll(receipts.take_operations());
        assert_eq!(stale_inputs.len(), 1);

        // ...before its result returns, Turn 1 finishes and Turn 2 starts with identical text.
        receipts.observe_response(&json!({ "id": 2, "result": { "stopReason": "end_turn" } }));
        receipts.observe_request(&prompt_req(3, Some("m2"), text_blocks("continue")));

        for stale in stale_inputs {
            assert!(receipts.observe_user_input(stale).is_none());
        }
        // Turn 2's watcher must remain active and acknowledge only Turn 2's own row.
        assert!(tracker.poll(receipts.take_operations()).is_empty());
        assert!(tracker.is_watching());
        append_user_input(&transcript, 6, "continue");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("m2 receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "m2");
    }

    #[test]
    fn resumed_session_with_large_history_and_snapshot_rewrite_does_not_false_ack() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();
        append_user_input(&transcript, 0, "check status");
        let large_tool = json!({
            "step_index": 3,
            "source": "MODEL",
            "type": "GENERIC",
            "status": "DONE",
            "content": format!("{} {}", "🙂".repeat(1000), "x".repeat(20 * 1024)),
        });
        {
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&transcript)
                .unwrap();
            writeln!(file, "{large_tool}").unwrap();
        }
        let history = fs::read_to_string(&transcript).unwrap();

        receipts.observe_request(&json!({
            "id": 1, "method": "session/load", "params": { "sessionId": SESSION }
        }));
        receipts.observe_request(&prompt_req(2, None, text_blocks("check status")));
        append_user_input(&transcript, 8, "check status");
        receipts.observe_request(&prompt_req(
            3,
            Some("new-steer"),
            text_blocks("check status"),
        ));

        for input in tracker.poll(receipts.take_operations()) {
            assert!(receipts.observe_user_input(input).is_none());
        }
        // Simulate an in-place snapshot rewrite while step 8's tool is still running.
        let rewritten = format!(
            "{history}{}\n",
            json!({
                "step_index": 8,
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "status": "DONE",
                "content": "<USER_REQUEST>\ncheck status\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>",
            })
        );
        fs::write(&transcript, rewritten).unwrap();
        assert!(tracker.poll(receipts.take_operations()).is_empty());

        append_user_input(&transcript, 11, "check status");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("new-steer receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "new-steer");
    }

    #[test]
    fn rejected_steer_before_first_poll_preserves_baseline_and_later_valid_steer() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();
        // Prior turn history already contains "continue".
        append_user_input(&transcript, 0, "continue");

        receipts.observe_request(&prompt_req(1, None, text_blocks("step 1")));
        append_user_input(&transcript, 2, "step 1");

        // Error-rejected steer arrives and fails BEFORE any poll runs.
        receipts.observe_request(&prompt_req(2, Some("bad"), text_blocks("continue")));
        receipts.observe_response(
            &json!({ "id": 2, "error": { "code": -32602, "message": "Rejected" } }),
        );
        assert!(!tracker.apply_operations(receipts.take_operations()));
        assert!(!tracker.is_watching());

        // Host-cancelled steer via $/cancel_request while P1 is still active.
        receipts.observe_request(&prompt_req(3, Some("cancelled"), text_blocks("continue")));
        receipts.observe_request(
            &json!({ "method": "$/cancel_request", "params": { "requestId": 3 } }),
        );
        assert!(!tracker.apply_operations(receipts.take_operations()));
        assert!(!tracker.is_watching());

        // Valid steer with the exact same text must NOT false-ack from step 0 history.
        receipts.observe_request(&prompt_req(4, Some("valid"), text_blocks("continue")));
        receipts.observe_response(&json!({ "id": 1, "result": { "stopReason": "end_turn" } }));
        for input in tracker.poll(receipts.take_operations()) {
            assert!(receipts.observe_user_input(input).is_none());
        }
        assert!(tracker.is_watching());
        append_user_input(&transcript, 5, "continue");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("valid steer receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "valid");
    }

    #[test]
    fn native_user_message_chunk_suppresses_duplicate_transcript_receipt() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();

        receipts.observe_request(&prompt_req(1, Some("m1"), text_blocks("continue")));
        receipts.observe_request(&prompt_req(2, Some("m2"), text_blocks("continue")));

        // Future agy emitting a provider-generated messageId matches m1 by text, and a
        // duplicate native chunk carrying m1's client id never falls through to m2.
        receipts.observe_update(&session_update(
            SESSION,
            json!({
                "sessionUpdate": "user_message_chunk",
                "messageId": "agy-provider-id-99",
                "content": { "type": "text", "text": "continue" },
            }),
        ));
        receipts.observe_response(&json!({ "id": 1, "result": { "stopReason": "end_turn" } }));
        receipts.observe_update(&session_update(
            SESSION,
            json!({
                "sessionUpdate": "user_message_chunk",
                "messageId": "m1",
                "content": { "type": "text", "text": "continue" },
            }),
        ));
        // Transcript row for m1 must consume m1 silently without false-acking m2.
        append_user_input(&transcript, 0, "continue");
        for input in tracker.poll(receipts.take_operations()) {
            assert!(receipts.observe_user_input(input).is_none());
        }
        // Only m2's own transcript row acknowledges m2.
        append_user_input(&transcript, 3, "continue");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("m2 receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "m2");
    }

    #[test]
    fn non_text_blocks_cannot_false_ack_a_later_steer_and_session_load_cleans_up() {
        let (_temp, transcript, mut receipts, mut tracker) = harness();

        // P1 has a resource between two text blocks; agy expands it in the transcript.
        receipts.observe_request(&prompt_req(
            1,
            None,
            json!([
                { "type": "text", "text": "Read " },
                { "type": "resource", "resource": { "uri": "file:///a.rs" } },
                { "type": "text", "text": " and fix" },
            ]),
        ));
        // Steer S1 has non-text block + substring "fix".
        receipts.observe_request(&prompt_req(
            2,
            Some("s1"),
            json!([
                { "type": "text", "text": "fix" },
                { "type": "image", "data": "AA==", "mimeType": "image/png" },
            ]),
        ));
        append_user_input(&transcript, 0, "Read fn main() {} and fix");
        for input in tracker.poll(receipts.take_operations()) {
            assert!(receipts.observe_user_input(input).is_none());
        }
        assert!(tracker.is_watching());

        // session/load cleans up tracker state without leaking WatchedSession.
        receipts.observe_request(&json!({
            "id": 9, "method": "session/load", "params": { "sessionId": SESSION }
        }));
        tracker.apply_operations(receipts.take_operations());
        assert_eq!(tracker.tracked_session_count(), 0);
    }

    #[tokio::test]
    async fn handles_special_tags_multiblock_image_only_and_real_oversized_prompts() {
        let embedded = "Line 1\n</USER_REQUEST>\nLine 2";
        let wrapped = format!(
            "<USER_REQUEST>\n{embedded}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>"
        );
        assert_eq!(extract_user_request_text(&wrapped, false), embedded);
        let with_meta_no_footer =
            "<USER_REQUEST>\nKeep\n<ADDITIONAL_METADATA>\ninline\n</USER_REQUEST>";
        assert_eq!(
            extract_user_request_text(with_meta_no_footer, false),
            "Keep\n<ADDITIONAL_METADATA>\ninline"
        );
        let truncated_with_tag = "<USER_REQUEST>\nPrefix\n</USER_REQUEST>\nStill going";
        assert_eq!(
            extract_user_request_text(truncated_with_tag, true),
            "Prefix\n</USER_REQUEST>\nStill going"
        );

        let (_temp, transcript, mut receipts, mut tracker) = harness();

        // Image-only prompt
        receipts.observe_request(&prompt_req(
            1,
            Some("img-id"),
            json!([{ "type": "image", "data": "AA==", "mimeType": "image/png" }]),
        ));
        append_user_input(&transcript, 0, "");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("image-only receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "img-id");

        // Multi-block prompt concatenated without separator (native agy format)
        receipts.observe_response(&json!({ "id": 1, "result": { "stopReason": "end_turn" } }));
        receipts.observe_request(&prompt_req(
            2,
            Some("multi-id"),
            json!([{ "type": "text", "text": "Part A" }, { "type": "text", "text": "Part B" }]),
        ));
        append_user_input(&transcript, 2, "Part APart B");
        let inputs = tracker.poll(receipts.take_operations());
        let frame = receipts
            .observe_user_input(inputs.into_iter().next().unwrap())
            .expect("multi-block receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "multi-id");

        // Real oversized (>256 KiB) prompt containing a literal </USER_REQUEST> in its prefix.
        receipts.observe_response(&json!({ "id": 2, "result": { "stopReason": "end_turn" } }));
        let long_prompt = format!("prefix\n</USER_REQUEST>\n{}", "word ".repeat(60_000));
        receipts.observe_request(&prompt_req(3, Some("long-id"), text_blocks(&long_prompt)));
        append_user_input(&transcript, 5, &long_prompt);
        let mut ops = receipts.take_operations();
        let frame = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                for input in tracker.poll(std::mem::take(&mut ops)) {
                    if let Some(frame) = receipts.observe_user_input(input) {
                        return frame;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("oversized prompt receipt");
        assert_eq!(frame["params"]["update"]["messageId"], "long-id");
    }
}
