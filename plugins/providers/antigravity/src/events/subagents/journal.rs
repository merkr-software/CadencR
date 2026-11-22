mod background;
mod cursor;
mod usage;

use std::collections::HashSet;

use cadencr_provider_sdk::meta::SubagentStatus;
use serde_json::{json, Value};

use self::background::{finished_task, started_task};
use self::cursor::JournalCursor;
use super::store::{read_record, NativeChild};
use crate::events::{session_update, tools};

const MAX_SUMMARY_CHARS: usize = 2048;

pub(super) struct ChildJournal {
    child: NativeChild,
    cursor: JournalCursor,
    usage: usage::ChildUsage,
    last_settled_step: Option<u64>,
    single_action: Option<(u64, String)>,
    background: HashSet<u64>,
}

impl ChildJournal {
    pub(super) fn new(child: NativeChild) -> Self {
        Self {
            child,
            cursor: JournalCursor::default(),
            usage: usage::ChildUsage::default(),
            last_settled_step: None,
            single_action: None,
            background: HashSet::new(),
        }
    }

    /// Returns whether the child still needs tracking.
    pub(super) fn poll(&mut self, root: &str, frames: &mut Vec<Value>) -> bool {
        let mut usage_changed = false;
        for row in self.cursor.read(&self.child.transcript) {
            usage_changed |= self.usage.observe(&row);
            if let Some(outcome) = self.observe_step(&row, root, frames) {
                frames.push(self.finish(root, outcome, row["content"].as_str()));
                return false;
            }
        }
        if read_record(&self.child.descriptor).is_some_and(|descriptor| {
            descriptor["conversationId"] == self.child.id
                && descriptor["state"] == "SUBAGENT_STATE_KILLED"
        }) {
            frames.push(self.finish(root, SubagentStatus::Cancelled, None));
            return false;
        }
        if usage_changed {
            frames.push(self.update(root, None, None));
        }
        true
    }

    fn observe_step(
        &mut self,
        step: &Value,
        root: &str,
        frames: &mut Vec<Value>,
    ) -> Option<SubagentStatus> {
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
                if !self.background.is_empty() {
                    if let Some(task) = finished_task(content, &self.child.id) {
                        self.background.remove(&task);
                    }
                }
                None
            }
            (Some("MODEL"), Some("GENERIC")) => {
                if let Some(outcome) = outcome {
                    self.background.remove(&index);
                    if fresh
                        && self
                            .single_action
                            .as_ref()
                            .is_some_and(|(action, _)| action.checked_add(1) == Some(index))
                    {
                        if let Some((_, id)) = self.single_action.take() {
                            frames.push(self.action_result(root, &id, outcome, content));
                        }
                    }
                } else if fresh
                    && status == "RUNNING"
                    && started_task(content, &self.child.id) == Some(index)
                {
                    self.background.insert(index);
                }
                None
            }
            (Some("MODEL"), Some("PLANNER_RESPONSE")) if fresh => {
                let outcome = outcome?;
                // The next planner step does not reveal the prior tool outcomes.
                self.single_action = None;
                match outcome {
                    SubagentStatus::Completed => self.observe_planner(step, index, root, frames),
                    _ => Some(outcome),
                }
            }
            _ => None,
        }
    }

    fn observe_planner(
        &mut self,
        step: &Value,
        index: u64,
        root: &str,
        frames: &mut Vec<Value>,
    ) -> Option<SubagentStatus> {
        let calls = match step.get("tool_calls") {
            None | Some(Value::Null) => &[],
            Some(Value::Array(calls)) => calls.as_slice(),
            _ => return None,
        };
        if !calls.is_empty() {
            for (position, call) in calls.iter().enumerate() {
                if let Some(name) = call["name"].as_str().filter(|name| !name.is_empty()) {
                    let id = format!("agy-child:{}:{index}:{position}", self.child.id);
                    frames.push(self.start_action(root, &id, name, call.get("args")));
                    if calls.len() == 1 {
                        self.single_action = Some((index, id));
                    }
                }
            }
            return None;
        }
        // The child can also send a tool-free reply while waiting for a command.
        (self.background.is_empty()
            && step["content"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()))
        .then_some(SubagentStatus::Completed)
    }

    fn start_action(&self, root: &str, id: &str, name: &str, args: Option<&Value>) -> Value {
        let mut update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": id,
            "parentToolCallId": self.child.carrier,
            "title": name,
            "name": name,
            "kind": "other",
            "status": "in_progress"
        });
        if let Some(args) = args.filter(|args| args.is_object()) {
            update["rawInput"] = args.clone();
        }
        if !tools::is_subagent_launch(name) {
            tools::normalize_update(&mut update, &[]);
        }
        session_update(root, update)
    }

    fn action_result(&self, root: &str, id: &str, outcome: SubagentStatus, output: &str) -> Value {
        let status = match outcome {
            SubagentStatus::Completed => "completed",
            SubagentStatus::Failed | SubagentStatus::Cancelled => "failed",
        };
        session_update(
            root,
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": id,
                "parentToolCallId": self.child.carrier,
                "status": status,
                "rawOutput": output
            }),
        )
    }

    fn finish(&self, root: &str, outcome: SubagentStatus, summary: Option<&str>) -> Value {
        let summary = summary.map(|text| {
            text.trim()
                .chars()
                .take(MAX_SUMMARY_CHARS)
                .collect::<String>()
        });
        self.update(root, Some(outcome), summary.as_deref())
    }

    fn update(&self, root: &str, status: Option<SubagentStatus>, summary: Option<&str>) -> Value {
        session_update(
            root,
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": self.child.carrier,
                "_meta": self.usage.metadata(status, summary)
            }),
        )
    }
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
        assert!(child.poll("root", &mut frames));
        assert_eq!(frames.len(), 1);
        frames.clear();

        fs::write(&transcript, format!("{initial}\n")).unwrap();
        assert!(child.poll("root", &mut frames));
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
        assert!(!child.poll("root", &mut frames));
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
        assert!(child.poll("root", &mut frames));
        assert!(frames.is_empty());

        plan["status"] = json!("DONE");
        append(&plan);
        assert!(child.poll("root", &mut frames));
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
        assert!(child.poll("root", &mut frames));
        assert!(frames.is_empty());

        read["status"] = json!("DONE");
        append(&read);
        assert!(child.poll("root", &mut frames));
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
        assert!(child.poll("root", &mut frames));
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
        assert!(!child.poll("root", &mut frames));
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
        assert_eq!(journal.observe_step(&started, "root", &mut frames), None);
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
            journal.observe_step(&failed_tool, "root", &mut frames),
            None
        );
        assert!(frames.is_empty());
        let failed_agent = json!({
            "step_index": 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "ERROR",
            "content": "Agent failed",
        });
        assert_eq!(
            journal.observe_step(&failed_agent, "root", &mut frames),
            Some(SubagentStatus::Failed)
        );
        assert!(frames.is_empty(), "individual outcomes are unknown");
    }
}
