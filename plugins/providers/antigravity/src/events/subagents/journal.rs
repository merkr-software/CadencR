mod background;
mod cursor;
mod frames;
mod nested;
mod projection;
mod report;
mod reports;
mod usage;

use std::path::Path;

use cadencr_provider_sdk::meta::SubagentStatus;
use serde_json::{json, Value};

use self::background::BackgroundTasks;
pub(in crate::events) use self::cursor::{read_exact_at, JournalCursor, SeekOutcome};
use self::nested::NestedChildren;
use self::projection::ProjectedRow;
use self::report::ReportDigest;
pub(super) use self::reports::ParentReports;
use super::store::{read_record, NativeChild};
use super::PARENT_ACTED;

pub(super) struct ChildJournal {
    child: NativeChild,
    cursor: JournalCursor,
    usage: usage::ChildUsage,
    last_settled_step: Option<u64>,
    single_action: Option<(u64, String)>,
    background: BackgroundTasks,
    nested: NestedChildren,
    pending_reply: Option<PendingReply>,
    depth: u8,
    parent: Option<String>,
    sent_report: Option<ReportDigest>,
    warned_about_schema: bool,
}

struct PendingReply {
    index: u64,
    summary: Option<String>,
    has_text: bool,
    report: Option<ReportDigest>,
}

struct FinishedChild {
    outcome: SubagentStatus,
    summary: Option<String>,
    report: Option<ReportDigest>,
}

pub(super) enum JournalPoll {
    Tracking,
    Finished,
    Unobservable,
}

impl ChildJournal {
    pub(super) fn new(child: NativeChild) -> Self {
        Self {
            child,
            cursor: JournalCursor::default(),
            usage: usage::ChildUsage::default(),
            last_settled_step: None,
            single_action: None,
            background: BackgroundTasks::default(),
            nested: NestedChildren::default(),
            pending_reply: None,
            depth: 1,
            parent: None,
            sent_report: None,
            warned_about_schema: false,
        }
    }

    pub(super) fn set_parent(&mut self, parent: &str) {
        self.parent = Some(parent.into());
    }

    #[cfg(test)]
    pub(super) fn poll(
        &mut self,
        brain: &Path,
        root: &str,
        frames: &mut Vec<Value>,
    ) -> JournalPoll {
        self.poll_for_parent(brain, root, frames, &ParentReports::default())
    }

    pub(super) fn poll_for_parent(
        &mut self,
        brain: &Path,
        root: &str,
        frames: &mut Vec<Value>,
        reports: &ParentReports,
    ) -> JournalPoll {
        let messages = reports.messages_for(&self.child.id);
        if let Some(child) = self.advance(brain, root, frames, &messages, reports.has_backlog()) {
            let mut frame = self.finish(root, child.outcome, child.summary.as_deref());
            if child
                .report
                .is_some_and(|report| reports.acted(report, &messages))
            {
                frame[PARENT_ACTED] = json!(true);
            }
            frames.push(frame);
            return JournalPoll::Finished;
        }
        if self.nested.is_unobservable() && self.pending_reply.is_some() {
            crate::native_compat::warn_journal(
                "a nested child launch or final report could not be linked within 30 seconds",
            );
            return JournalPoll::Unobservable;
        }
        JournalPoll::Tracking
    }

    fn advance(
        &mut self,
        brain: &Path,
        root: &str,
        frames: &mut Vec<Value>,
        parent_messages: &[(ReportDigest, u64)],
        parent_backlog: bool,
    ) -> Option<FinishedChild> {
        let mut usage_changed = false;
        let records = self.cursor.read(&self.child.transcript);
        if self.cursor.take_invalid_record() {
            self.warn_about_schema();
        }
        for record in records {
            usage_changed |= self.usage.observe(&record.value);
            if let Some(outcome) = self.observe_projected_step(&record, root, frames) {
                let summary = record.value["content"].as_str().map(ToOwned::to_owned);
                if outcome != SubagentStatus::Completed {
                    return Some(FinishedChild {
                        outcome,
                        summary,
                        report: None,
                    });
                }
                if let Some(index) = record.value["step_index"].as_u64() {
                    self.pending_reply = Some(PendingReply {
                        index,
                        summary,
                        has_text: record.report.reply.is_some(),
                        report: self.sent_report.or(record.report.reply),
                    });
                }
            }
        }
        self.nested.poll(brain, &self.child.id, self.depth);
        if !self.has_backlog() {
            if self.pending_reply.as_ref().is_some_and(|reply| {
                self.background.ready(reply.index)
                    && self.nested.ready(reply.index)
                    && (!parent_backlog || reply.report.is_none())
                    && (reply.has_text
                        || reply.report.is_some_and(|report| {
                            parent_messages
                                .iter()
                                .any(|(message, _)| *message == report)
                        }))
            }) {
                return self.pending_reply.take().map(|reply| FinishedChild {
                    outcome: SubagentStatus::Completed,
                    summary: reply.summary,
                    report: reply.report,
                });
            }
            if read_record(&self.child.descriptor).is_some_and(|descriptor| {
                descriptor["conversationId"] == self.child.id
                    && descriptor["state"] == "SUBAGENT_STATE_KILLED"
            }) {
                return Some(FinishedChild {
                    outcome: SubagentStatus::Cancelled,
                    summary: None,
                    report: None,
                });
            }
        }
        if usage_changed {
            frames.push(self.update(root, None, None));
        }
        None
    }

    fn warn_about_schema(&mut self) {
        if !self.warned_about_schema {
            self.warned_about_schema = true;
            crate::native_compat::warn_journal("a child transcript contains an unreadable record");
        }
    }

    pub(super) fn has_backlog(&self) -> bool {
        self.cursor.has_backlog() || self.nested.has_backlog()
    }

    #[cfg(test)]
    fn observe_step(
        &mut self,
        step: &Value,
        content_truncated: bool,
        root: &str,
        frames: &mut Vec<Value>,
    ) -> Option<SubagentStatus> {
        let mut record = ProjectedRow::from_value(step.clone());
        record.content_truncated = content_truncated;
        self.observe_projected_step(&record, root, frames)
    }

    fn observe_projected_step(
        &mut self,
        record: &ProjectedRow,
        root: &str,
        frames: &mut Vec<Value>,
    ) -> Option<SubagentStatus> {
        let step = &record.value;
        let index = step["step_index"].as_u64()?;
        let status = step["status"].as_str()?;
        let outcome = step_outcome(status);
        let fresh = self.last_settled_step.is_none_or(|last| index > last);
        if fresh && outcome.is_some() {
            self.last_settled_step = Some(index);
        }
        let content = step["content"].as_str().unwrap_or_default();
        match (step["source"].as_str(), step["type"].as_str()) {
            (Some("SYSTEM"), Some("SYSTEM_MESSAGE")) if status == "DONE" => {
                // A rewritten journal can supply an earlier notification we missed.
                self.background
                    .observe_notification(content, &self.child.id, index);
                self.discard_blocked_reply();
                if let Some(report) = &record.report.delivered {
                    self.nested.observe_message(report, index);
                }
                None
            }
            (Some("MODEL"), Some("GENERIC")) => {
                // A snapshot can finish the tool call that launched a background
                // task while the task itself remains active.
                let launched = matches!(status, "RUNNING" | "DONE")
                    && self
                        .background
                        .observe_launch(content, &self.child.id, index);
                if launched {
                    self.discard_blocked_reply();
                } else if let Some(outcome) = outcome {
                    self.background.settle(index);
                    self.nested.observe_result(
                        index,
                        &self.child.id,
                        (outcome == SubagentStatus::Completed).then_some(content),
                    );
                    if fresh
                        && self
                            .single_action
                            .as_ref()
                            .is_some_and(|(action, _)| tool_result_step(*action, 0) == Some(index))
                    {
                        if let Some((_, id)) = self.single_action.take() {
                            let output = (!record.content_truncated).then_some(content);
                            frames.push(self.action_result(root, &id, outcome, output));
                        }
                    }
                }
                None
            }
            (Some("MODEL"), Some("PLANNER_RESPONSE")) => {
                if status == "DONE" {
                    if let Some(calls) = step["tool_calls"].as_array() {
                        self.background.observe_plan(index, calls);
                        self.nested.observe_plan(index, self.depth, calls);
                    }
                }
                if !fresh {
                    return None;
                }
                self.pending_reply = None;
                let outcome = outcome?;
                // The next planner step does not reveal the prior tool outcomes.
                self.single_action = None;
                match outcome {
                    SubagentStatus::Completed => self.observe_planner(record, index, root, frames),
                    _ => Some(outcome),
                }
            }
            _ => None,
        }
    }

    fn discard_blocked_reply(&mut self) {
        if self
            .pending_reply
            .as_ref()
            .is_some_and(|reply| !self.background.ready(reply.index))
        {
            self.pending_reply = None;
            self.sent_report = None;
        }
    }

    fn observe_planner(
        &mut self,
        record: &ProjectedRow,
        index: u64,
        root: &str,
        frames: &mut Vec<Value>,
    ) -> Option<SubagentStatus> {
        let step = &record.value;
        let calls = match step.get("tool_calls") {
            None | Some(Value::Null) => &[],
            Some(Value::Array(calls)) => calls.as_slice(),
            _ => {
                self.warn_about_schema();
                return None;
            }
        };
        if !calls.is_empty() {
            // A report followed by another tool plan can be a progress update.
            self.sent_report = None;
            for (position, call) in calls.iter().enumerate() {
                if let Some(name) = call["name"].as_str().filter(|name| !name.is_empty()) {
                    if name == "send_message"
                        && calls.len() == 1
                        && self.parent.as_deref() == call["args"]["Recipient"].as_str()
                    {
                        self.sent_report = record.report.sent;
                    }
                    let id = format!("agy-child:{}:{index}:{position}", self.child.id);
                    frames.push(self.start_action(root, &id, name, call.get("args")));
                    if calls.len() == 1 {
                        self.single_action = Some((index, id));
                    }
                }
            }
            return None;
        }
        // A tool-free step can also be a wait or a private thought. An
        // explicit empty nested reply needs corroboration from the parent.
        let content = step["content"].as_str()?;
        let candidate = record.report.reply.is_some()
            || (content.is_empty() && self.parent.is_some() && self.sent_report.is_some());
        if !self.background.ready(index) {
            self.sent_report = None;
            return None;
        }
        candidate.then_some(SubagentStatus::Completed)
    }

    pub(super) fn carrier(&self) -> &str {
        &self.child.carrier
    }
}

/// agy records the result for each batched tool directly after its planner step.
fn tool_result_step(planner: u64, position: usize) -> Option<u64> {
    planner.checked_add(position as u64)?.checked_add(1)
}

fn step_outcome(status: &str) -> Option<SubagentStatus> {
    match status {
        "DONE" => Some(SubagentStatus::Completed),
        "ERROR" => Some(SubagentStatus::Failed),
        "CANCELED" | "INTERRUPTED" | "HALTED" => Some(SubagentStatus::Cancelled),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use super::*;

    #[test]
    fn ambiguous_planner_content_keeps_tracking_until_native_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let brain = temp.path();
        let transcript = brain.join("transcript");
        let descriptor = brain.join("descriptor.json");
        let mut child = ChildJournal::new(NativeChild {
            id: "fixture-child".into(),
            carrier: "call-1".into(),
            descriptor: descriptor.clone(),
            transcript: transcript.clone(),
        });
        let mut journal = String::new();
        for (index, content) in [
            None,
            Some(Value::Null),
            Some(json!({"unknown_format": "Done"})),
            Some(json!("\n ")),
            Some(json!("")),
        ]
        .into_iter()
        .enumerate()
        {
            let mut row = json!({
                "step_index": index,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "thinking": "A finished reasoning step"
            });
            if let Some(content) = content {
                row["content"] = content;
            }
            journal.push_str(&format!("{row}\n"));
        }
        fs::write(transcript, journal).unwrap();
        let mut frames = Vec::new();
        assert!(matches!(
            child.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        fs::write(
            descriptor,
            json!({"conversationId":"fixture-child","state":"SUBAGENT_STATE_KILLED"}).to_string(),
        )
        .unwrap();
        assert!(matches!(
            child.poll(brain, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent"),
            Some(&json!({"status":"cancelled"}))
        );
    }

    #[test]
    fn repeated_and_truncated_snapshots_do_not_duplicate_known_actions() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = temp.path().join("transcript_full.jsonl");
        let child = NativeChild {
            id: "fixture-child".into(),
            carrier: "call-1".into(),
            descriptor: temp.path().join("child.json"),
            transcript: transcript.clone(),
        };
        let initial = json!({"step_index": 0, "type": "SYSTEM_MESSAGE"});
        let first_action = json!({
            "step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
            "tool_calls": [{"name": "read_file", "args":{"Path":"/fixture.txt"}}],
        });
        fs::write(&transcript, format!("{initial}\n{first_action}\n")).unwrap();
        let mut child = ChildJournal::new(child);
        let mut frames = Vec::new();
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 1);
        frames.clear();

        fs::write(&transcript, format!("{initial}\n")).unwrap();
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());
        let final_reply = json!({
            "step_index": 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
            "content": "Done",
        });
        fs::write(
            &transcript,
            format!("{initial}\n{first_action}\n{final_reply}\n"),
        )
        .unwrap();
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(frames.len(), 1, "only the child outcome was reported");
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent/status"),
            Some(&json!("completed"))
        );
    }

    #[test]
    fn later_rows_can_settle_in_progress_steps_at_the_same_index() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = temp.path().join("transcript_full.jsonl");
        let mut child = ChildJournal::new(NativeChild {
            id: "fixture-child".into(),
            carrier: "call-1".into(),
            descriptor: temp.path().join("child.json"),
            transcript: transcript.clone(),
        });
        let append = |row: &Value| {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&transcript)
                .unwrap();
            writeln!(file, "{row}").unwrap();
        };
        let mut frames = Vec::new();
        let mut plan = json!({
            "step_index":1, "source":"MODEL", "type":"PLANNER_RESPONSE",
            "status":"IN_PROGRESS", "tool_calls":[{"name":"read_file"}]
        });
        append(&plan);
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        plan["status"] = json!("DONE");
        append(&plan);
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].pointer("/params/update/status"),
            Some(&json!("in_progress"))
        );
        frames.clear();

        let mut read = json!({
            "step_index":2, "source":"MODEL", "type":"GENERIC", "status":"RUNNING",
            "content":"Fixture file"
        });
        append(&read);
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        read["status"] = json!("DONE");
        append(&read);
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].pointer("/params/update/status"),
            Some(&json!("completed"))
        );
        assert_eq!(
            frames[0].pointer("/params/update/rawOutput"),
            Some(&json!("Fixture file"))
        );
        frames.clear();

        let mut reply = json!({
            "step_index":3, "source":"MODEL", "type":"PLANNER_RESPONSE",
            "status":"GENERATING", "content":"Child final reply",
            "model":"child-model","input_tokens":12,"cache_read_tokens":3,"output_tokens":2
        });
        append(&reply);
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].pointer("/params/update/toolCallId"),
            Some(&json!("call-1"))
        );
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent"),
            Some(&json!({"resolvedModel":"child-model","totalTokens":17}))
        );
        frames.clear();
        reply["output_tokens"] = json!(5);

        reply["status"] = json!("DONE");
        append(&reply);
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent"),
            Some(
                &json!({"status":"completed","summary":"Child final reply","totalTokens":20,"resolvedModel":"child-model"})
            )
        );
    }

    #[test]
    fn parallel_batches_do_not_guess_the_output_or_status_of_individual_actions() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal = ChildJournal::new(NativeChild {
            id: "fixture-child".into(),
            carrier: "call-1".into(),
            descriptor: temp.path().join("child.json"),
            transcript: temp.path().join("transcript_full.jsonl"),
        });
        let mut frames = Vec::new();
        let started = json!({
            "step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
            "tool_calls": [{"name": "read_file"}, {"name": "grep_search"}],
        });
        assert_eq!(
            journal.observe_step(&started, false, "root", &mut frames),
            None
        );
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|frame| {
            frame.pointer("/params/update/status") == Some(&json!("in_progress"))
        }));
        frames.clear();

        let failed_tool = json!({
            "step_index": 2, "source": "MODEL", "type": "GENERIC", "status": "ERROR",
            "content": "Permission denied",
        });
        assert_eq!(
            journal.observe_step(&failed_tool, false, "root", &mut frames),
            None
        );
        assert!(frames.is_empty());
        let failed_agent = json!({
            "step_index": 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "ERROR",
            "content": "Agent failed",
        });
        assert_eq!(
            journal.observe_step(&failed_agent, false, "root", &mut frames),
            Some(SubagentStatus::Failed)
        );
        assert!(frames.is_empty(), "individual outcomes are unknown");
    }
}
