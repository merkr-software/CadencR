use std::collections::HashMap;

#[derive(Clone, Copy)]
enum TaskKind {
    Command,
    Timer,
}

/// agy addresses each task by the owning child's ID and its journal step.
#[derive(Default)]
pub(super) struct BackgroundTasks(HashMap<u64, TaskKind>);

impl BackgroundTasks {
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(super) fn remove(&mut self, index: u64) {
        self.0.remove(&index);
    }

    pub(super) fn observe_running(&mut self, content: &str, child: &str, index: u64) {
        let mut lines = content
            .lines()
            .skip_while(|line| line.starts_with("Created At: "));
        let task = lines.next().and_then(|header| {
            header.strip_prefix("Tool is running as a background task with task id: ")
        });
        if task.and_then(|id| task_step(id, child)) != Some(index) {
            return;
        }
        let kind = match lines
            .next()
            .and_then(|line| line.strip_prefix("Task Description: Timer: "))
        {
            Some(description) if description.contains(", Prompt: ") => TaskKind::Timer,
            _ => TaskKind::Command,
        };
        self.0.insert(index, kind);
    }

    pub(super) fn observe_notification(&mut self, content: &str, child: &str) {
        if self.0.is_empty() {
            return;
        }
        let Some((sender, body)) = task_message(content) else {
            return;
        };
        let Some(step) = task_step(sender, child) else {
            return;
        };
        match self.0.get(&step) {
            // A timer delivers the reminder itself. A command can send output,
            // so only its native terminal notification settles it.
            Some(TaskKind::Timer) => self.remove(step),
            Some(TaskKind::Command) if command_finished(sender, body) => self.remove(step),
            _ => {}
        }
    }
}

fn task_step(id: &str, child: &str) -> Option<u64> {
    id.strip_prefix(child)?.strip_prefix("/task-")?.parse().ok()
}

fn task_message(content: &str) -> Option<(&str, &str)> {
    let (_, message) = content.split_once("<SYSTEM_MESSAGE>\n")?;
    let header = message
        .lines()
        .next()?
        .strip_prefix("[Message] timestamp=")?;
    let (_, fields) = header.split_once(" sender=")?;
    let (sender, fields) = fields.split_once(" priority=")?;
    let (_, body) = fields.split_once(" content=")?;
    Some((sender, body))
}

fn command_finished(sender: &str, body: &str) -> bool {
    let Some((task, outcome)) = body
        .strip_prefix("Task id \"")
        .and_then(|rest| rest.split_once('"'))
    else {
        return false;
    };
    task == sender
        && matches!(
            outcome,
            " finished with result:" | " was canceled with result:"
        )
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
    fn cancellations_and_expired_timers_release_only_their_own_task() {
        let temp = tempfile::tempdir().unwrap();
        let mut child = ChildJournal::new(NativeChild {
            id: "child".into(),
            carrier: "launch".into(),
            descriptor: temp.path().join("descriptor"),
            transcript: temp.path().join("journal"),
        });
        let mut frames = Vec::new();
        let mut row = |step, source, kind, state, text: &str| {
            child.observe_step(
            &json!({"step_index":step,"source":source,"type":kind,"status":state,"content":text}), "root",&mut frames)
        };
        row(3,"MODEL","GENERIC","RUNNING","Tool is running as a background task with task id: child/task-3\nTask Description: Timer: 30s, Prompt: Retry");
        row(4,"MODEL","GENERIC","RUNNING","Tool is running as a background task with task id: child/task-4\nTask Description: Run tests");
        row(5,"SYSTEM","SYSTEM_MESSAGE","DONE","<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-4 priority=high content=Ordinary message");
        row(6,"SYSTEM","SYSTEM_MESSAGE","DONE","<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-3 priority=high content=Retry");
        assert_eq!(row(7, "MODEL", "PLANNER_RESPONSE", "DONE", "Waiting"), None);
        row(8,"SYSTEM","SYSTEM_MESSAGE","DONE","<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-4 priority=low content=Task id \"child/task-4\" was canceled with result:\nTool execution was canceled");
        assert_eq!(
            row(9, "MODEL", "PLANNER_RESPONSE", "DONE", "Final report"),
            Some(SubagentStatus::Completed)
        );
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
