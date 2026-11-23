use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use cadencr_provider_sdk::meta::SubagentStatus;
use serde_json::Value;

use super::super::store::{read_nested_child, uuid_segment};
use super::report::{DeliveredReport, ReportDigest};
use super::{tool_result_step, ChildJournal};

// The native CLI limits nesting to ten levels beneath the primary agent.
const MAX_NESTING_DEPTH: u8 = 10;
const EVIDENCE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REMEMBERED_REPORTS: usize = 32;

#[derive(Default)]
pub(super) struct NestedChildren {
    launch_results: HashMap<u64, Option<Instant>>,
    children: HashMap<String, NestedRun>,
}

struct NestedRun {
    messages: Vec<(ReportDigest, u64)>,
    journal: Option<ChildJournal>,
    outcome: Option<SubagentStatus>,
    final_report: Option<ReportDigest>,
    evidence_since: Instant,
    unobservable: bool,
}

impl Default for NestedRun {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            journal: None,
            outcome: None,
            final_report: None,
            evidence_since: Instant::now(),
            unobservable: false,
        }
    }
}

impl NestedChildren {
    pub(super) fn observe_plan(&mut self, index: u64, depth: u8, calls: &[Value]) {
        if depth >= MAX_NESTING_DEPTH {
            return;
        }
        for (position, call) in calls.iter().enumerate() {
            if call["name"]
                .as_str()
                .is_some_and(crate::events::tools::is_subagent_launch)
            {
                if let Some(step) = tool_result_step(index, position) {
                    self.launch_results
                        .entry(step)
                        .or_insert_with(|| Some(Instant::now()));
                }
            }
        }
    }

    pub(super) fn observe_result(&mut self, index: u64, parent: &str, completed: Option<&str>) {
        // Keep settled slots so a refreshed journal cannot rearm the same launch.
        if self
            .launch_results
            .get_mut(&index)
            .and_then(Option::take)
            .is_none()
        {
            return;
        }
        if let Some(id) = completed.and_then(launched_child).filter(|id| id != parent) {
            self.children.entry(id).or_default();
        }
    }

    pub(super) fn observe_message(&mut self, report: &DeliveredReport, index: u64) {
        if let Some(child) = self.children.get_mut(&report.sender) {
            if let Some((_, previous)) = child
                .messages
                .iter_mut()
                .find(|(hash, _)| *hash == report.digest)
            {
                *previous = index.max(*previous);
                return;
            }
            if child.messages.len() == MAX_REMEMBERED_REPORTS {
                child.messages.remove(0);
            }
            child.messages.push((report.digest, index));
        }
    }

    pub(super) fn poll(&mut self, brain: &Path, parent: &str, depth: u8) {
        for (id, run) in &mut self.children {
            if run.outcome.is_some() || run.unobservable {
                continue;
            }
            if run.journal.is_none() {
                run.journal = read_nested_child(brain, parent, id).map(|child| {
                    let mut journal = ChildJournal::new(child);
                    journal.depth = depth + 1;
                    journal.parent = Some(parent.into());
                    journal
                });
            }
            if let Some(journal) = &mut run.journal {
                if let Some(child) =
                    journal.advance(brain, "", &mut Vec::new(), &run.messages, false)
                {
                    run.outcome = Some(child.outcome);
                    run.final_report = child.report;
                    run.evidence_since = Instant::now();
                    run.journal = None;
                } else if journal.nested.is_unobservable() {
                    run.unobservable = true;
                    run.journal = None;
                }
            }
        }
    }

    pub(super) fn has_backlog(&self) -> bool {
        self.children
            .values()
            .filter_map(|run| run.journal.as_ref())
            .any(ChildJournal::has_backlog)
    }

    pub(super) fn ready(&self, step: u64) -> bool {
        !self.launch_results.values().any(Option::is_some)
            && self.children.values().all(|child| {
                match child.outcome {
                    // Match the final native report to the parent's delivery
                    // rather than mistaking an earlier progress message for it.
                    Some(SubagentStatus::Completed) => {
                        child.report_step().is_some_and(|message| message < step)
                    }
                    Some(SubagentStatus::Cancelled | SubagentStatus::Failed) => true,
                    None => false,
                }
            })
    }

    pub(super) fn is_unobservable(&self) -> bool {
        self.launch_results
            .values()
            .flatten()
            .any(|started| started.elapsed() >= EVIDENCE_TIMEOUT)
            || self.children.values().any(|child| {
                child.unobservable
                    || (child.journal.is_none()
                        && match child.outcome {
                            None => true,
                            Some(SubagentStatus::Completed) => child.report_step().is_none(),
                            _ => false,
                        }
                        && child.evidence_since.elapsed() >= EVIDENCE_TIMEOUT)
            })
    }
}

impl NestedRun {
    fn report_step(&self) -> Option<u64> {
        let report = self.final_report?;
        self.messages
            .iter()
            .find_map(|(hash, step)| (*hash == report).then_some(*step))
    }
}

fn launched_child(content: &str) -> Option<String> {
    let (_, body) = content.split_once("Created the following subagent:\n")?;
    let record = serde_json::Deserializer::from_str(body)
        .into_iter::<Value>()
        .next()?
        .ok()?;
    let id = record["conversationId"]
        .as_str()
        .filter(|id| uuid_segment(id))?;
    Some(id.into())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    use serde_json::json;

    use super::super::{JournalPoll, NativeChild};
    use super::*;

    const PARENT: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const CHILD: &str = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

    fn record(contents: &Value) -> String {
        format!("{contents}\n")
    }

    fn step(index: u64, kind: &str, content: &str) -> Value {
        json!({"step_index":index,"source":"MODEL","status":"DONE","type":kind,"content":content})
    }

    fn message(index: u64, content: &str) -> Value {
        json!({
            "step_index":index,"source":"SYSTEM","status":"DONE","type":"SYSTEM_MESSAGE",
            "content":format!("Created At: t\n<SYSTEM_MESSAGE>\n[Message] timestamp=t sender={CHILD} priority=high content={content}\n</SYSTEM_MESSAGE>")
        })
    }

    fn report(index: u64, content: &str) -> Value {
        json!({
            "step_index":index,"source":"MODEL","status":"DONE","type":"PLANNER_RESPONSE",
            "tool_calls":[{"name":"send_message","args":{"Recipient":PARENT,"Message":content}}]
        })
    }

    fn parent_journal(brain: &Path) -> ChildJournal {
        let parent = brain.join(PARENT).join(".system_generated");
        fs::create_dir_all(parent.join("subagents")).unwrap();
        let transcript = parent.join("parent.jsonl");
        let launch = json!({
            "step_index":1,"source":"MODEL","status":"DONE","type":"PLANNER_RESPONSE",
            "tool_calls":[{"name":"invoke_subagent","args":{"Role":"Researcher"}}]
        });
        let result = step(
            2,
            "GENERIC",
            &format!(
                "Created At: t\nCompleted At: t\nCreated the following subagent:\n{{\"conversationId\":\"{CHILD}\"}}\nThe subagent will send you a message"
            ),
        );
        fs::write(&transcript, [record(&launch), record(&result)].concat()).unwrap();
        ChildJournal::new(NativeChild {
            id: PARENT.into(),
            carrier: "root-launch".into(),
            descriptor: parent.join("descriptor.json"),
            transcript,
        })
    }

    fn register_child(brain: &Path) -> PathBuf {
        let logs = brain.join(CHILD).join(".system_generated/logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            brain
                .join(PARENT)
                .join(format!(".system_generated/subagents/{CHILD}.json")),
            json!({"conversationId":CHILD,"state":"SUBAGENT_STATE_ALIVE"}).to_string(),
        )
        .unwrap();
        logs.join("transcript_full.jsonl")
    }

    fn append_rows(transcript: &Path, rows: &[Value]) {
        let mut dest = fs::OpenOptions::new()
            .append(true)
            .open(transcript)
            .unwrap();
        for row in rows {
            dest.write_all(record(row).as_bytes()).unwrap();
        }
    }

    #[test]
    fn only_the_delivered_final_nested_report_releases_the_parent_wait() {
        let temp = tempfile::tempdir().unwrap();
        let brain = temp.path();
        let mut parent = parent_journal(brain);
        let child_transcript = register_child(brain);
        let progress = "Working on it";
        let final_report = "Done\nEverything checked";
        fs::write(&child_transcript, record(&report(1, progress))).unwrap();
        let mut transcript = fs::OpenOptions::new()
            .append(true)
            .open(&parent.child.transcript)
            .unwrap();
        write!(
            transcript,
            "{}{}",
            record(&message(3, progress)),
            record(&step(4, "PLANNER_RESPONSE", "Waiting"))
        )
        .unwrap();
        let mut frames = Vec::new();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));

        fs::write(
            &child_transcript,
            [
                record(&report(1, progress)),
                record(&report(3, final_report)),
                record(&step(5, "PLANNER_RESPONSE", "")),
            ]
            .concat(),
        )
        .unwrap();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));

        write!(transcript, "{}", record(&message(5, final_report))).unwrap();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));

        write!(
            transcript,
            "{}",
            record(&step(6, "PLANNER_RESPONSE", "Parent completed"))
        )
        .unwrap();
        frames.clear();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent"),
            Some(&json!({"status":"completed","summary":"Parent completed"}))
        );
    }

    #[test]
    fn a_nested_text_reply_matches_only_its_own_delivery() {
        for previous_progress in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let brain = temp.path();
            let mut parent = parent_journal(brain);
            let child_transcript = register_child(brain);
            let progress = "A progress update";
            let final_text = "The final result";
            let mut rows = Vec::new();
            if previous_progress {
                rows.extend([
                    report(1, progress),
                    json!({
                        "step_index":2,"source":"MODEL","status":"DONE","type":"PLANNER_RESPONSE",
                        "tool_calls":[{"name":"read_file","args":{"Path":"fixture.txt"}}]
                    }),
                ]);
            }
            rows.push(step(4, "PLANNER_RESPONSE", final_text));
            fs::write(
                child_transcript,
                rows.iter().map(record).collect::<String>(),
            )
            .unwrap();
            append_rows(
                &parent.child.transcript,
                &[message(3, progress), step(4, "PLANNER_RESPONSE", "Waiting")],
            );
            let mut frames = Vec::new();
            assert!(matches!(
                parent.poll(brain, "root", &mut frames),
                JournalPoll::Tracking
            ));

            append_rows(&parent.child.transcript, &[message(5, final_text)]);
            assert!(matches!(
                parent.poll(brain, "root", &mut frames),
                JournalPoll::Tracking
            ));

            append_rows(
                &parent.child.transcript,
                &[step(6, "PLANNER_RESPONSE", "Parent completed")],
            );
            frames.clear();
            assert!(matches!(
                parent.poll(brain, "root", &mut frames),
                JournalPoll::Finished
            ));
            assert_eq!(
                frames[0].pointer("/params/update/_meta/cadencr/subagent/summary"),
                Some(&json!("Parent completed"))
            );
        }
    }

    #[test]
    fn a_delayed_nested_launch_result_keeps_the_parent_running() {
        let temp = tempfile::tempdir().unwrap();
        let brain = temp.path();
        let mut parent = parent_journal(brain);
        let transcript = parent.child.transcript.clone();
        let initial = fs::read_to_string(&transcript).unwrap();
        let launch = initial.lines().next().unwrap();
        let waiting = record(&step(3, "PLANNER_RESPONSE", "Waiting"));
        fs::write(&transcript, format!("{launch}\n{waiting}")).unwrap();
        let mut frames = Vec::new();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));

        let child = register_child(brain);
        let final_text = "Nested child completed";
        fs::write(child, record(&step(1, "PLANNER_RESPONSE", final_text))).unwrap();
        let replacement = transcript.with_extension("replacement");
        fs::write(&replacement, format!("{initial}{waiting}")).unwrap();
        fs::rename(replacement, &transcript).unwrap();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));

        append_rows(
            &transcript,
            &[
                message(4, final_text),
                step(5, "PLANNER_RESPONSE", "Parent completed"),
            ],
        );
        frames.clear();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent/summary"),
            Some(&json!("Parent completed"))
        );
    }

    #[test]
    fn a_failed_launch_settles_only_its_own_batch_step() {
        let mut children = NestedChildren::default();
        let calls = [
            json!({"name":"read_file"}),
            json!({"name":"invoke_subagent"}),
        ];
        children.observe_plan(1, 1, &calls);
        children.observe_result(2, PARENT, None);
        assert!(!children.ready(4));

        children.observe_result(3, PARENT, None);
        children.observe_plan(1, 1, &calls);
        assert!(children.ready(4));
    }

    #[tokio::test]
    async fn matches_the_entire_oversized_nested_report() {
        use std::time::Duration;

        use super::super::cursor::READ_BUDGET;

        let temp = tempfile::tempdir().unwrap();
        let brain = temp.path();
        let mut parent = parent_journal(brain);
        let child = register_child(brain);
        let prefix = "x".repeat(READ_BUDGET + 10);
        let right = format!("{prefix}\n🙂 </SYSTEM_MESSAGE> quoted result A");
        let wrong = format!("{prefix}\n🙂 </SYSTEM_MESSAGE> quoted result B");
        let sent = format!("\u{2003}{right}\t\n");
        fs::write(
            child,
            [
                record(&report(1, &sent)),
                record(&step(3, "PLANNER_RESPONSE", "")),
            ]
            .concat(),
        )
        .unwrap();
        append_rows(
            &parent.child.transcript,
            &[
                message(3, &wrong),
                step(4, "PLANNER_RESPONSE", "Still waiting"),
            ],
        );
        let mut frames = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                assert!(matches!(
                    parent.poll(brain, "root", &mut frames),
                    JournalPoll::Tracking
                ));
                if !parent.has_backlog() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        append_rows(
            &parent.child.transcript,
            &[
                message(5, &right),
                step(6, "PLANNER_RESPONSE", "Parent completed"),
            ],
        );
        frames.clear();
        tokio::time::timeout(Duration::from_secs(5), async {
            while matches!(
                parent.poll(brain, "root", &mut frames),
                JournalPoll::Tracking
            ) {
                assert!(parent.has_backlog());
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            frames
                .last()
                .unwrap()
                .pointer("/params/update/_meta/cadencr/subagent/summary"),
            Some(&json!("Parent completed"))
        );
    }

    #[test]
    fn a_missing_nested_journal_releases_tracking_without_inventing_an_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let brain = temp.path();
        let mut parent = parent_journal(brain);
        let mut transcript = fs::OpenOptions::new()
            .append(true)
            .open(&parent.child.transcript)
            .unwrap();
        write!(
            transcript,
            "{}",
            record(&step(4, "PLANNER_RESPONSE", "Waiting"))
        )
        .unwrap();
        let mut frames = Vec::new();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Tracking
        ));
        parent
            .nested
            .children
            .get_mut(CHILD)
            .unwrap()
            .evidence_since -= EVIDENCE_TIMEOUT;
        frames.clear();
        assert!(matches!(
            parent.poll(brain, "root", &mut frames),
            JournalPoll::Unobservable
        ));
        assert!(frames.is_empty());
    }
}
