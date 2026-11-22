//! Project Antigravity's local child transcript into the parent ACP stream.

mod journal;
mod store;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use cadencr_provider_sdk::meta::{merge_meta, subagent_background_meta};
use serde_json::Value;

use self::journal::ChildJournal;
use self::store::{native_brain, uuid_segment, Discovery};
use super::tools::{call_name, is_subagent_launch};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct Subagents {
    sessions: HashMap<String, HashSet<String>>,
    operations: Vec<SubagentOperation>,
}

pub(crate) enum SubagentOperation {
    Dispatched { session: String, carrier: String },
    Closed(String),
}

impl Subagents {
    pub(super) fn observe_request(&mut self, message: &Value) {
        let Some(session) = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .filter(|id| uuid_segment(id))
        else {
            return;
        };
        match message.get("method").and_then(Value::as_str) {
            Some("session/prompt") => {
                self.sessions.entry(session.to_owned()).or_default();
            }
            Some("session/close") if self.sessions.remove(session).is_some() => {
                self.operations
                    .push(SubagentOperation::Closed(session.into()));
            }
            _ => {}
        }
    }

    pub(super) fn observe_update(&mut self, message: &mut Value) {
        let Some(id) = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return;
        };
        let Some(starting) = self.sessions.get_mut(&id) else {
            return;
        };
        let Some(update) = message
            .pointer_mut("/params/update")
            .and_then(Value::as_object_mut)
        else {
            return;
        };
        let Some(carrier) = update.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let status = update.get("status").and_then(Value::as_str);
        match (update.get("sessionUpdate").and_then(Value::as_str), status) {
            (Some("tool_call"), None | Some("pending" | "in_progress")) => {
                if call_name(update).is_some_and(is_subagent_launch) {
                    starting.insert(carrier.to_owned());
                }
            }
            (Some("tool_call_update"), Some("completed")) if starting.remove(carrier) => {
                self.operations.push(SubagentOperation::Dispatched {
                    session: id,
                    carrier: carrier.to_owned(),
                });
                merge_meta(update, subagent_background_meta());
            }
            (Some("tool_call_update"), Some("failed")) => {
                starting.remove(carrier);
            }
            _ => {}
        }
    }

    pub(super) fn take_operations(&mut self) -> Vec<SubagentOperation> {
        std::mem::take(&mut self.operations)
    }

    pub(super) fn can_forward(&self, frame: &Value) -> bool {
        frame
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| {
                self.sessions.contains_key(id) && !self.operations.iter().any(|operation| {
                matches!(operation, SubagentOperation::Closed(session) if session == id)
            })
            })
    }
}

pub(crate) struct SubagentTracker {
    brain: Option<PathBuf>,
    pub(crate) unobserved: Vec<(String, String)>,
    sessions: HashMap<String, Session>,
}

#[derive(Default)]
struct Session {
    discovery: Discovery,
    awaiting_child: HashMap<String, Instant>,
    children: HashMap<String, ChildJournal>,
}

impl SubagentTracker {
    pub(crate) fn new(args: &[OsString]) -> Self {
        Self {
            brain: native_brain(args),
            unobserved: Vec::new(),
            sessions: HashMap::new(),
        }
    }

    pub(crate) fn is_idle(&self) -> bool {
        self.sessions
            .values()
            .all(|session| session.awaiting_child.is_empty() && session.children.is_empty())
    }

    pub(crate) fn has_pending_launches(&self) -> bool {
        self.sessions
            .values()
            .any(|session| !session.awaiting_child.is_empty())
    }

    pub(crate) fn poll(&mut self, operations: Vec<SubagentOperation>) -> Vec<Value> {
        let Some(brain) = self.brain.as_ref() else {
            for op in operations {
                if let SubagentOperation::Dispatched { session, carrier } = op {
                    self.unobserved.push((session, carrier));
                }
            }
            return Vec::new();
        };
        let now = Instant::now();
        for operation in operations {
            match operation {
                SubagentOperation::Dispatched { session, carrier } => {
                    self.sessions
                        .entry(session)
                        .or_default()
                        .awaiting_child
                        .insert(carrier, now);
                }
                SubagentOperation::Closed(session) => {
                    self.sessions.remove(&session);
                }
            }
        }
        let mut frames = Vec::new();
        for (id, session) in &mut self.sessions {
            for (carrier, _) in session
                .awaiting_child
                .extract_if(|_, started| now.duration_since(*started) >= DISCOVERY_TIMEOUT)
            {
                self.unobserved.push((id.clone(), carrier));
            }
            if session.awaiting_child.is_empty() {
                session.discovery.pause();
            } else {
                session.discovery.scan(brain, id);
                for child in session
                    .discovery
                    .take_children(|carrier| session.awaiting_child.remove(carrier).is_some())
                {
                    session
                        .children
                        .insert(child.id.clone(), ChildJournal::new(child));
                }
            }
            session
                .children
                .retain(|_, journal| journal.poll(id, &mut frames));
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::*;
    use crate::events::session_update;

    const ROOT: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const FOREIGN: &str = "ffffffff-ffff-4fff-ffff-ffffffffffff";
    const CHILD_A: &str = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const CHILD_B: &str = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const MESSAGE_A: &str = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const MESSAGE_B: &str = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";

    fn dispatch(observer: &mut Subagents, id: &str) -> Value {
        observer.observe_update(&mut session_update(ROOT, json!({
            "sessionUpdate":"tool_call","toolCallId":id,"name":"invoke_subagent","status":"in_progress",
            "rawInput":{"Role":"Researcher"}
        })));
        let mut message = session_update(
            ROOT,
            json!({
                "sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed",
                "_meta":{"native":{"keep":true}}
            }),
        );
        observer.observe_update(&mut message);
        message
    }

    fn put_child(brain: &Path, child: &str, spawn: u64) -> PathBuf {
        let registry = brain.join(ROOT).join(".system_generated/subagents");
        fs::create_dir_all(&registry).unwrap();
        fs::write(
            registry.join(format!("{child}.json")),
            json!({
                "conversationId":child, "spawnStepIndex":spawn,
                "state":"SUBAGENT_STATE_ALIVE", "subagentDescriptor":{"role":"Researcher"}
            })
            .to_string(),
        )
        .unwrap();
        let logs = brain.join(child).join(".system_generated/logs");
        fs::create_dir_all(&logs).unwrap();
        logs.join("transcript_full.jsonl")
    }

    fn put_message(brain: &Path, child: &str, message: &str, value: Value) {
        let messages = brain.join(child).join(".system_generated/messages");
        fs::create_dir_all(&messages).unwrap();
        fs::write(messages.join(format!("{message}.json")), value.to_string()).unwrap();
    }

    fn launch(sender: &str, recipient: &str, spawn: u64, id: &str) -> Value {
        json!({"sender":sender,"recipient":recipient,"sourceMetadata":{"tool":{
            "conversationId":sender,"stepIndex":spawn,"toolCall":{"id":id,"name":"invoke_subagent"}
        }}})
    }

    fn update(frame: &Value) -> &Value {
        frame.pointer("/params/update").unwrap()
    }

    fn append(path: &Path, value: &str) {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(value.as_bytes()).unwrap();
    }

    #[test]
    fn batched_launches_share_a_registry_step_but_each_follow_their_own_call() {
        let test = tempfile::tempdir().unwrap();
        let brain = test.path();
        let children = [
            (CHILD_A, 35, "first"),
            (CHILD_B, 36, "second"),
            ("11111111-1111-4111-8111-111111111111", 37, "third"),
        ];
        let mut tracker = SubagentTracker {
            brain: Some(brain.to_owned()),
            unobserved: Vec::new(),
            sessions: HashMap::new(),
        };
        let mut observer = Subagents::default();
        observer.observe_request(&json!({"method":"session/prompt","params":{"sessionId":ROOT}}));
        let journals = children.map(|(id, step, carrier)| {
            let log = put_child(brain, id, 37);
            put_message(brain, id, MESSAGE_A, launch(ROOT, id, step, carrier));
            append(
                &log,
                &format!(
                    "{}\n",
                    json!({
                        "step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
                        "tool_calls":[{"name":"read_file","args":{"Path":id}}]
                    })
                ),
            );
            dispatch(&mut observer, carrier);
            (id, carrier, log)
        });
        let actions = tracker.poll(observer.take_operations());
        assert_eq!(actions.len(), 3);
        for (id, carrier, log) in journals.into_iter().rev() {
            assert!(actions
                .iter()
                .map(update)
                .any(|u| u["parentToolCallId"] == carrier && u["rawInput"]["file_path"] == id));
            append(
                &log,
                &format!(
                    "{}\n",
                    json!({
                        "step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":id
                    })
                ),
            );
            let frames = tracker.poll(Vec::new());
            assert_eq!(frames.len(), 1);
            assert_eq!(update(&frames[0])["toolCallId"], carrier);
            assert_eq!(
                update(&frames[0])["_meta"]["cadencr"]["subagent"],
                json!({"status":"completed","summary":id})
            );
        }
        assert!(tracker.is_idle());
    }

    #[test]
    fn discovering_a_child_before_its_journal_preserves_the_launch_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let brain = directory.path();
        let first = put_child(brain, CHILD_A, 2);
        put_child(brain, CHILD_B, 3);
        let mut tracker = SubagentTracker {
            brain: Some(brain.to_owned()),
            unobserved: Vec::new(),
            sessions: HashMap::new(),
        };
        let dispatches = [(CHILD_A, "late"), (CHILD_B, "missing")].map(|(id, carrier)| {
            put_message(brain, id, MESSAGE_A, launch(ROOT, id, 2, carrier));
            SubagentOperation::Dispatched {
                session: ROOT.to_owned(),
                carrier: carrier.to_owned(),
            }
        });
        assert!(tracker.poll(Vec::from(dispatches)).is_empty());
        assert_eq!(tracker.sessions[ROOT].awaiting_child.len(), 2);

        append(&first, "{\"step_index\":4,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"Reported\"}\n");
        let wait = &mut tracker.sessions.get_mut(ROOT).unwrap().awaiting_child;
        *wait.get_mut("missing").unwrap() = Instant::now() - DISCOVERY_TIMEOUT;
        let frames = tracker.poll(Vec::new());
        assert_eq!(frames.len(), 1);
        assert_eq!(update(&frames[0])["toolCallId"], "late");
        assert_eq!(
            update(&frames[0])["_meta"]["cadencr"]["subagent"]["status"],
            "completed"
        );
        assert_eq!(
            tracker.unobserved,
            [(ROOT.to_owned(), "missing".to_owned())]
        );
        assert!(tracker.is_idle());
    }

    #[test]
    fn discovery_advances_across_multiple_message_batches() {
        let test = tempfile::tempdir().unwrap();
        let brain = test.path();
        let transcript = put_child(brain, CHILD_A, 2);
        for n in 0..36 {
            let id = format!("10000000-0000-4000-8000-{n:012x}");
            put_message(
                brain,
                CHILD_A,
                &id,
                launch(FOREIGN, CHILD_A, 2, "unrelated"),
            );
        }
        put_message(brain, CHILD_A, MESSAGE_A, launch(ROOT, CHILD_A, 2, "call"));
        append(
            &transcript,
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"Finished\"}\n",
        );
        let mut tracker = SubagentTracker {
            brain: Some(brain.to_owned()),
            unobserved: Vec::new(),
            sessions: HashMap::new(),
        };
        assert!(tracker
            .poll(vec![SubagentOperation::Dispatched {
                session: ROOT.to_owned(),
                carrier: "call".to_owned(),
            }])
            .is_empty());
        assert!(tracker.poll(Vec::new()).is_empty());
        let frames = tracker.poll(Vec::new());
        assert_eq!(frames.len(), 1);
        assert_eq!(update(&frames[0])["toolCallId"], "call");
    }

    #[test]
    fn concurrent_launches_follow_exact_lineage_and_report_live_actions_then_terminal_status() {
        let test = tempfile::tempdir().unwrap();
        let brain = test.path();
        let a = put_child(brain, CHILD_A, 2);
        let b = put_child(brain, CHILD_B, 3);
        put_message(
            brain,
            CHILD_A,
            MESSAGE_A,
            launch(FOREIGN, CHILD_A, 2, "call-a"),
        );
        put_message(
            brain,
            CHILD_B,
            MESSAGE_A,
            launch(ROOT, CHILD_B, 3, "call-b"),
        );
        append(&a, "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"read_file\",\"args\":{\"Path\":\"/fixture.txt\"}}]}\n");
        append(&b, "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"printf fixture\"}}]}\n");

        let mut observer = Subagents::default();
        observer.observe_request(&json!({"method":"session/prompt", "params":{"sessionId":ROOT}}));
        for id in ["call-a", "call-b"] {
            let dispatched = dispatch(&mut observer, id);
            assert_eq!(update(&dispatched)["status"], "completed");
            assert_eq!(update(&dispatched)["_meta"]["native"]["keep"], true);
            assert_eq!(
                update(&dispatched)["_meta"]["cadencr"]["subagent"]["background"],
                true
            );
        }

        let mut tracker = SubagentTracker {
            brain: Some(brain.to_owned()),
            unobserved: Vec::new(),
            sessions: HashMap::new(),
        };
        let frames = tracker.poll(observer.take_operations());
        assert_eq!(frames.len(), 1, "only verified child B can be displayed");
        assert_eq!(update(&frames[0])["parentToolCallId"], "call-b");
        assert_eq!(update(&frames[0])["name"], "Bash");
        assert_eq!(update(&frames[0])["rawInput"]["command"], "printf fixture");

        put_message(
            brain,
            CHILD_A,
            MESSAGE_B,
            launch(ROOT, CHILD_A, 2, "call-a"),
        );
        append(
            &b,
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"GENERIC\",\"status\":\"DONE\"}\n",
        );
        append(&b, "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"");
        let frames = tracker.poll(Vec::new());
        assert_eq!(frames.len(), 2);
        let action_a = frames
            .iter()
            .map(update)
            .find(|u| u["parentToolCallId"] == "call-a")
            .unwrap();
        assert_eq!(action_a["rawInput"]["file_path"], "/fixture.txt");
        let result_b = frames
            .iter()
            .map(update)
            .find(|u| u["parentToolCallId"] == "call-b")
            .unwrap();
        assert_eq!(result_b["status"], "completed");
        assert_eq!(result_b["rawOutput"], "");

        append(&b, "Child B result\"}\n");
        let frames = tracker.poll(Vec::new());
        assert_eq!(frames.len(), 1);
        assert_eq!(update(&frames[0])["toolCallId"], "call-b");
        assert_eq!(
            update(&frames[0])["_meta"]["cadencr"]["subagent"],
            json!({
                "status":"completed","summary":"Child B result"
            })
        );
        assert!(!tracker.is_idle(), "A is still running");
        assert!(tracker.poll(Vec::new()).is_empty());
        let killed = brain
            .join(ROOT)
            .join(format!(".system_generated/subagents/{CHILD_A}.json"));
        fs::write(
            killed,
            json!({"conversationId":CHILD_A,"state":"SUBAGENT_STATE_KILLED"}).to_string(),
        )
        .unwrap();
        let cancelled = tracker.poll(Vec::new());
        assert_eq!(cancelled.len(), 1);
        assert_eq!(update(&cancelled[0])["toolCallId"], "call-a");
        assert_eq!(
            update(&cancelled[0])["_meta"]["cadencr"]["subagent"]["status"],
            "cancelled"
        );
        observer.observe_request(&json!({"method":"session/close","params":{"sessionId":ROOT}}));
        assert!(!observer.can_forward(&frames[0]));
        assert!(tracker.poll(observer.take_operations()).is_empty());
        assert!(tracker.is_idle());
    }
}
