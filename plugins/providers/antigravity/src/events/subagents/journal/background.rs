/// The native journal identifies detached commands by <child>/task-<step>.
pub(super) fn started_task(content: &str, child: &str) -> Option<u64> {
    let header = content
        .lines()
        .find(|line| !line.starts_with("Created At: "))?;
    let id = header.strip_prefix("Tool is running as a background task with task id: ")?;
    task_step(id, child)
}

fn task_step(id: &str, child: &str) -> Option<u64> {
    id.strip_prefix(child)?.strip_prefix("/task-")?.parse().ok()
}

pub(super) fn finished_task(content: &str, child: &str) -> Option<u64> {
    let (_, message) = content.split_once("<SYSTEM_MESSAGE>\n")?;
    let header = message
        .lines()
        .next()?
        .strip_prefix("[Message] timestamp=")?;
    let (_, fields) = header.split_once(" sender=")?;
    let (sender, fields) = fields.split_once(" priority=")?;
    let (_, result) = fields.split_once(" content=Task id \"")?;
    let task = result.strip_suffix("\" finished with result:")?;
    if sender != task {
        return None;
    }
    task_step(sender, child)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::super::{cursor, ChildJournal, NativeChild, SubagentStatus};
    use serde_json::json;

    #[test]
    fn background_tasks_keep_tool_free_waits_open_until_each_task_has_returned() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal = ChildJournal::new(NativeChild {
            id: "child".into(),
            carrier: "launch".into(),
            descriptor: temp.path().join("child.json"),
            transcript: temp.path().join("transcript_full.jsonl"),
        });
        let mut frames = Vec::new();
        let mut observe = |step| journal.observe_step(&step, "root", &mut frames);
        let running = |index| {
            json!({
                "source":"MODEL","type":"GENERIC","status":"RUNNING","step_index":index,
                "content":format!("Created At: now\nTool is running as a background task with task id: child/task-{index}\nTask Description: example")
            })
        };
        let message = |index, sender: &str| {
            json!({
                "source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","step_index":index,
                "content":format!("<SYSTEM_MESSAGE>\n[Message] timestamp=now sender={sender} priority=MESSAGE_PRIORITY_HIGH content=Task id \"{sender}\" finished with result:\nDone\n</SYSTEM_MESSAGE>")
            })
        };
        let reply = |index| {
            json!({
                "source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","step_index":index,
                "content":"A tool-free reply"
            })
        };
        assert_eq!(observe(running(3)), None);
        assert_eq!(observe(running(4)), None);
        assert_eq!(observe(reply(5)), None);
        assert_eq!(observe(message(6, "other/task-3")), None);
        assert_eq!(observe(message(7, "child/task-4")), None);
        assert_eq!(observe(reply(8)), None);
        assert_eq!(observe(message(9, "child/task-3")), None);
        assert_eq!(observe(reply(10)), Some(SubagentStatus::Completed));
    }

    #[test]
    fn rewritten_journal_settles_large_tasks_without_replaying_work() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = temp.path().join("transcript_full.jsonl");
        let mut child = ChildJournal::new(NativeChild {
            id: "child".into(),
            carrier: "launch".into(),
            descriptor: temp.path().join("child.json"),
            transcript: transcript.clone(),
        });
        // Preserve agy's field order. Its command output follows the task header.
        let output = "x".repeat(cursor::READ_BUDGET);
        let start_text = json!(format!("Created At: t\nTool is running as a background task with task id: child/task-3\nTask Description: test\n{output}"));
        let start = format!(
            r#"{{"step_index":3,"source":"MODEL","type":"GENERIC","status":"RUNNING","content":{start_text}}}"#
        );
        let wait = json!({"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Waiting"});
        let reminder = json!({"step_index":7,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":"Reminder"});
        fs::write(&transcript, format!("{start}\n{wait}\n{reminder}\n")).unwrap();
        let mut frames = Vec::new();
        for _ in 0..2 {
            assert!(child.poll("root", &mut frames));
        }
        assert!(frames.is_empty());

        let result_text = json!(format!("<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-3 priority=high content=Task id \"child/task-3\" finished with result:\n{output}\n</SYSTEM_MESSAGE>"));
        let result = format!(
            r#"{{"step_index":6,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":{result_text}}}"#
        );
        let done = json!({"step_index":8,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"All done"});
        let replacement = temp.path().join("replacement");
        fs::write(
            &replacement,
            format!("{start}\n{wait}\n{result}\n{reminder}\n{done}\n"),
        )
        .unwrap();
        fs::rename(replacement, &transcript).unwrap();
        assert!(child.poll("root", &mut frames));
        assert!(child.poll("root", &mut frames));
        assert!(!child.poll("root", &mut frames));
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent"),
            Some(&json!({"status":"completed","summary":"All done"}))
        );
    }
}
