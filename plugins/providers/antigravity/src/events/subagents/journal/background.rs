use std::collections::HashMap;

use serde_json::Value;

use super::tool_result_step;

#[derive(Clone, Copy)]
enum TaskKind {
    Command,
    Timer,
}

/// agy addresses each task by the owning child's ID and its journal step.
#[derive(Default)]
pub(super) struct BackgroundTasks {
    tasks: HashMap<u64, Task>,
    daemons: HashMap<u64, DaemonLaunch>,
}

enum DaemonLaunch {
    Command(String),
    Cron(String),
}

impl DaemonLaunch {
    fn matches(&self, description: &str) -> bool {
        match self {
            Self::Command(command) => command == description,
            Self::Cron(expression) => description
                .strip_prefix("Cron: ")
                .and_then(|text| text.split_once(", Prompt: "))
                .is_some_and(|(cron, _)| expression == cron),
        }
    }
}

#[derive(Default)]
struct Task {
    kind: Option<TaskKind>,
    daemon: bool,
    terminal_at: Option<u64>,
    message_at: Option<u64>,
}

impl Task {
    fn blocks(&self, reply: u64) -> bool {
        if self.daemon {
            return false;
        }
        let terminal = match self.kind {
            Some(TaskKind::Timer) => self.terminal_at.max(self.message_at),
            _ => self.terminal_at,
        };
        // A reply written before the task's notification can be a wait message.
        terminal.map_or(self.kind.is_some(), |step| step > reply)
    }
}

impl BackgroundTasks {
    pub(super) fn ready(&self, reply: u64) -> bool {
        !self.tasks.values().any(|task| task.blocks(reply))
    }

    pub(super) fn settle(&mut self, index: u64) {
        if let Some(task) = self.tasks.get_mut(&index) {
            task.terminal_at = task.terminal_at.max(Some(index));
        }
    }

    pub(super) fn observe_plan(&mut self, index: u64, calls: &[Value]) {
        for (position, call) in calls.iter().enumerate() {
            let step = tool_result_step(index, position);
            if let Some((step, launch)) = step.zip(daemon_launch(call)) {
                self.daemons.insert(step, launch);
            }
        }
    }

    pub(super) fn observe_launch(&mut self, content: &str, child: &str, index: u64) -> bool {
        let mut lines = content
            .lines()
            .skip_while(|line| line.starts_with("Created At: "));
        let task = lines.next().and_then(|header| {
            header.strip_prefix("Tool is running as a background task with task id: ")
        });
        if task.and_then(|id| task_step(id, child)) != Some(index) {
            return false;
        }
        let description = lines
            .next()
            .and_then(|line| line.strip_prefix("Task Description: "));
        let task = self.tasks.entry(index).or_default();
        task.daemon |= description.is_some_and(|text| {
            self.daemons
                .get(&index)
                .is_some_and(|launch| launch.matches(text))
        });
        task.kind = if !task.daemon
            && description
                .is_some_and(|text| text.starts_with("Timer: ") && text.contains(", Prompt: "))
        {
            Some(TaskKind::Timer)
        } else {
            Some(TaskKind::Command)
        };
        true
    }

    pub(super) fn observe_notification(&mut self, content: &str, child: &str, index: u64) {
        let Some((sender, body)) = addressed_message(content) else {
            return;
        };
        let Some(step) = task_step(sender, child) else {
            return;
        };
        if step >= index {
            return;
        }
        let task = self.tasks.entry(step).or_default();
        // A timer delivers the reminder itself. Commands can send other output,
        // so require their native terminal notification to confirm completion.
        task.message_at = task.message_at.max(Some(index));
        if command_finished(sender, body.lines().next().unwrap_or_default()) {
            task.terminal_at = task.terminal_at.max(Some(index));
        }
    }
}

fn daemon_launch(call: &Value) -> Option<DaemonLaunch> {
    let args = &call["args"];
    if args["IsDaemon"].as_bool() != Some(true) {
        return None;
    }
    match call["name"].as_str()? {
        "run_command" => args["CommandLine"]
            .as_str()?
            .lines()
            .next()
            .filter(|line| !line.is_empty())
            .map(|line| DaemonLaunch::Command(line.to_owned())),
        "schedule" => args["CronExpression"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(|expression| DaemonLaunch::Cron(expression.to_owned())),
        _ => None,
    }
}

fn task_step(id: &str, child: &str) -> Option<u64> {
    id.strip_prefix(child)?.strip_prefix("/task-")?.parse().ok()
}

pub(super) fn addressed_message(content: &str) -> Option<(&str, &str)> {
    let (_, message) = content.split_once("<SYSTEM_MESSAGE>\n")?;
    let header = message.strip_prefix("[Message] timestamp=")?;
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
    use std::path::Path;

    use super::super::{cursor, ChildJournal, JournalPoll, NativeChild, SubagentStatus};
    use serde_json::{json, Value};

    fn child(path: &Path) -> ChildJournal {
        ChildJournal::new(NativeChild {
            id: "child".into(),
            carrier: "launch".into(),
            descriptor: path.join("child.json"),
            transcript: path.join("journal"),
        })
    }

    fn command(index: u64, status: &str, description: &str) -> Value {
        json!({
            "source":"MODEL","type":"GENERIC","status":status,"step_index":index,
            "content":format!("Created At: t\nTool is running as a background task with task id: child/task-{index}\nTask Description: {description}")
        })
    }

    fn plan(index: u64, calls: &[Value]) -> Value {
        json!({"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","step_index":index,"tool_calls":calls})
    }

    fn reply(index: u64, text: &str) -> Value {
        json!({"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","step_index":index,"content":text})
    }

    fn result(index: u64, task: u64) -> Value {
        json!({
            "source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","step_index":index,
            "content":format!("<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-{task} priority=MESSAGE_PRIORITY_HIGH content=Task id \"child/task-{task}\" finished with result:\nOutput\n</SYSTEM_MESSAGE>")
        })
    }

    fn snapshot(path: &Path, rows: &[Value]) {
        let replacement = path.join("replacement");
        let journal = rows
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>();
        fs::write(&replacement, journal).unwrap();
        fs::rename(replacement, path.join("journal")).unwrap();
    }

    #[test]
    fn a_terminal_snapshot_header_still_blocks_until_each_command_reports() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut child = child(path);
        let mut frames = Vec::new();
        let first = command(2, "DONE", "sleep 2");
        let second = command(3, "RUNNING", "sleep 3");
        let wait = reply(4, "Waiting for both commands");
        let second_result = result(5, 3);
        let still_waiting = reply(6, "Waiting for the first command");
        let rows = [first, second, wait, second_result, still_waiting];
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        let mut rows = Vec::from(rows);
        rows.push(result(7, 2));
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        rows.push(reply(8, "Both commands returned"));
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent/summary"),
            Some(&json!("Both commands returned"))
        );
    }

    #[test]
    fn a_refreshed_older_row_can_register_a_background_command() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut child = child(path);
        let mut frames = Vec::new();
        let later_row = json!({"source":"MODEL","type":"GENERIC","status":"DONE","step_index":3,"content":"Another tool's output"});
        snapshot(path, std::slice::from_ref(&later_row));
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));

        let launch = command(2, "RUNNING", "sleep 2");
        let wait = reply(4, "Waiting for the earlier command");
        snapshot(path, &[launch.clone(), later_row.clone(), wait.clone()]);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        snapshot(
            path,
            &[
                launch,
                later_row,
                wait,
                result(5, 2),
                reply(6, "Command returned"),
            ],
        );
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Finished
        ));
    }

    #[test]
    fn a_delayed_task_result_invalidates_a_waiting_reply_already_read() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut child = child(path);
        let mut frames = Vec::new();
        let wait = reply(4, "Waiting for the command");
        let oversized = json!({"source":"MODEL","type":"GENERIC","status":"DONE","step_index":5,"content":"x".repeat(cursor::READ_BUDGET)});
        snapshot(path, &[wait.clone(), oversized]);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(child.has_backlog());

        let mut rows = vec![command(2, "RUNNING", "sleep 2"), wait, result(5, 2)];
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(frames.is_empty());

        rows.push(reply(6, "Command returned"));
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent/summary"),
            Some(&json!("Command returned"))
        );
    }

    #[test]
    fn only_the_confirmed_native_daemon_can_outlive_its_child() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut child = child(path);
        let mut frames = Vec::new();
        let calls = [
            json!({"name":"run_command","args":{"CommandLine":"same command","IsDaemon":true}}),
            json!({"name":"run_command","args":{"CommandLine":"same command","IsDaemon":false}}),
            json!({"name":"run_command","args":{"CommandLine":"other command"}}),
        ];
        let mut rows = vec![
            plan(1, &calls),
            command(2, "RUNNING", "same command"),
            command(3, "RUNNING", "same command"),
            command(4, "RUNNING", "other command"),
            result(5, 4),
            reply(6, "Waiting for the foreground work"),
        ];
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 3);

        rows.extend([
            result(7, 3),
            reply(8, "Command returned and service is running"),
        ]);
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(frames.len(), 4);
    }

    #[test]
    fn an_unmatched_result_does_not_inherit_the_daemon_plan() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut child = child(path);
        let mut frames = Vec::new();
        let calls =
            [json!({"name":"run_command","args":{"CommandLine":"daemon command","IsDaemon":true}})];
        let mut rows = vec![
            plan(1, &calls),
            command(2, "RUNNING", "another command"),
            reply(3, "Still waiting"),
        ];
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 1);

        rows.extend([result(4, 2), reply(5, "Command returned")]);
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn explicit_daemon_cron_does_not_block_its_child_but_a_timer_does() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut child = child(path);
        let mut frames = Vec::new();
        let calls = [
            json!({"name":"schedule","args":{"CronExpression":"*/5 * * * *","Prompt":"Heartbeat","IsDaemon":true}}),
            json!({"name":"schedule","args":{"DurationSeconds":30,"Prompt":"Check output"}}),
        ];
        let mut rows = vec![
            plan(1, &calls),
            command(2, "RUNNING", "Cron: */5 * * * *, Prompt: Heartbeat"),
            command(3, "RUNNING", "Timer: 30s, Prompt: Check output"),
            reply(4, "Waiting for the timer"),
        ];
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert_eq!(frames.len(), 2);

        rows.extend([
            result(5, 3),
            reply(6, "Timer fired and heartbeat remains scheduled"),
        ]);
        snapshot(path, &rows);
        assert!(matches!(
            child.poll(path, "root", &mut frames),
            JournalPoll::Finished
        ));
        assert_eq!(frames.len(), 3);
    }

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
        let mut observe = |step| journal.observe_step(&step, false, "root", &mut frames);
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
            &json!({"step_index":step,"source":source,"type":kind,"status":state,"content":text}), false, "root",&mut frames)
        };
        row(
            3,
            "MODEL",
            "GENERIC",
            "RUNNING",
            "Tool is running as a background task with task id: child/task-3\nTask Description: Timer: 30s, Prompt: Retry",
        );
        row(
            4,
            "MODEL",
            "GENERIC",
            "RUNNING",
            "Tool is running as a background task with task id: child/task-4\nTask Description: Run tests",
        );
        row(
            5,
            "SYSTEM",
            "SYSTEM_MESSAGE",
            "DONE",
            "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-4 priority=high content=Ordinary message",
        );
        row(
            6,
            "SYSTEM",
            "SYSTEM_MESSAGE",
            "DONE",
            "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-3 priority=high content=Retry",
        );
        assert_eq!(row(7, "MODEL", "PLANNER_RESPONSE", "DONE", "Waiting"), None);
        row(
            8,
            "SYSTEM",
            "SYSTEM_MESSAGE",
            "DONE",
            "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-4 priority=low content=Task id \"child/task-4\" was canceled with result:\nTool execution was canceled",
        );
        assert_eq!(
            row(9, "MODEL", "PLANNER_RESPONSE", "DONE", "Final report"),
            Some(SubagentStatus::Completed)
        );
    }

    #[tokio::test]
    async fn rewritten_journal_settles_large_tasks_without_replaying_work() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = temp.path().join("transcript_full.jsonl");
        let mut child = ChildJournal::new(NativeChild {
            id: "child".into(),
            carrier: "launch".into(),
            descriptor: temp.path().join("child.json"),
            transcript: transcript.clone(),
        });
        // Lifecycle metadata can follow a large output field.
        let output = "x".repeat(cursor::READ_BUDGET);
        let start_text = json!(format!(
            "Created At: t\nTool is running as a background task with task id: child/task-3\nTask Description: test\n{output}"
        ));
        let start = format!(
            r#"{{"content":{start_text},"step_index":3,"source":"MODEL","type":"GENERIC","status":"RUNNING"}}"#
        );
        let wait = json!({"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Waiting"});
        let reminder = json!({"step_index":7,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":"Reminder"});
        fs::write(&transcript, format!("{start}\n{wait}\n{reminder}\n")).unwrap();
        let mut frames = Vec::new();
        assert!(matches!(
            child.poll(temp.path(), "root", &mut frames),
            JournalPoll::Tracking
        ));
        assert!(child.has_backlog());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while child.has_backlog() {
                assert!(matches!(
                    child.poll(temp.path(), "root", &mut frames),
                    JournalPoll::Tracking
                ));
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(frames.is_empty());

        let result_text = json!(format!(
            "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=child/task-3 priority=high content=Task id \"child/task-3\" finished with result:\n{output}\n</SYSTEM_MESSAGE>"
        ));
        let result = format!(
            r#"{{"content":{result_text},"step_index":6,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE"}}"#
        );
        let done = json!({"step_index":8,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"All done"});
        let replacement = temp.path().join("replacement");
        fs::write(
            &replacement,
            format!("{start}\n{wait}\n{result}\n{reminder}\n{done}\n"),
        )
        .unwrap();
        fs::rename(replacement, &transcript).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while matches!(
                child.poll(temp.path(), "root", &mut frames),
                JournalPoll::Tracking
            ) {
                assert!(child.has_backlog());
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].pointer("/params/update/_meta/cadencr/subagent"),
            Some(&json!({"status":"completed","summary":"All done"}))
        );
    }
}
