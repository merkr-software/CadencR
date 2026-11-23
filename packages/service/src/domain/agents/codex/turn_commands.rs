//! The commands each Codex turn started, so that a Stop ends them.
//!
//! Codex runs a command in a terminal it keeps past the turn: `turn/interrupt`
//! ends the turn but leaves a command still running (a foreground script, a
//! `sleep`) as a background terminal of the thread, in its own session, where
//! no signal to the app-server's process group reaches it. Codex stops it, with
//! everything it started, on `thread/backgroundTerminals/terminate`, given the
//! `processId` its command item carried.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::event_items::item_type;

/// A command a turn started: its thread and Codex's `processId` for it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct TurnCommand {
    pub thread: String,
    pub process: String,
}

/// Commands started per `(thread, turn)` while that turn runs.
#[derive(Default)]
pub(super) struct TurnCommands {
    by_turn: HashMap<(String, String), BTreeSet<String>>,
}

pub(super) type SharedTurnCommands = Arc<Mutex<TurnCommands>>;

impl TurnCommands {
    /// Follow one app-server notification, of any thread.
    pub(super) fn observe(&mut self, method: &str, params: &Value) {
        let text = |pointer: &str| params.pointer(pointer).and_then(Value::as_str);
        match method {
            "item/started" | "item/completed" if item_type(params) == Some("commandExecution") => {
                let (Some(thread), Some(turn), Some(process)) =
                    (text("/threadId"), text("/turnId"), text("/item/processId"))
                else {
                    return;
                };
                let key = (thread.to_string(), turn.to_string());
                if method == "item/started" {
                    self.by_turn
                        .entry(key)
                        .or_default()
                        .insert(process.to_string());
                } else if params
                    .pointer("/item/exitCode")
                    .is_some_and(|code| !code.is_null())
                {
                    // It exited. A completed item without an exit code is a
                    // command Codex keeps running (a background terminal).
                    if let Some(processes) = self.by_turn.get_mut(&key) {
                        processes.remove(process);
                    }
                }
            }
            // A turn that ended is no longer Stop's to clean up: what it left
            // running on purpose (a dev server) stays.
            "turn/completed" => {
                if let (Some(thread), Some(turn)) = (text("/threadId"), text("/turn/id")) {
                    self.by_turn.remove(&(thread.to_string(), turn.to_string()));
                }
            }
            _ => {}
        }
    }

    /// The commands `turn` of `thread` started, or every running turn of the
    /// thread's when its turn is not known.
    pub(super) fn started_by(&self, thread: &str, turn: Option<&str>) -> Vec<TurnCommand> {
        self.by_turn
            .iter()
            .filter(|((owner, started_in), _)| {
                owner == thread && turn.is_none_or(|turn| turn == started_in)
            })
            .flat_map(|((owner, _), processes)| {
                processes.iter().map(|process| TurnCommand {
                    thread: owner.clone(),
                    process: process.clone(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn started(thread: &str, turn: &str, item: serde_json::Value) -> serde_json::Value {
        json!({ "threadId": thread, "turnId": turn, "item": item, "startedAtMs": 0 })
    }

    fn command(process: &str) -> serde_json::Value {
        json!({ "type": "commandExecution", "id": format!("exec-{process}"),
                "command": "/bin/zsh -lc ./slow-check.sh", "processId": process,
                "status": "inProgress" })
    }

    fn processes(commands: &TurnCommands, thread: &str, turn: Option<&str>) -> Vec<String> {
        let mut found: Vec<_> = commands
            .started_by(thread, turn)
            .into_iter()
            .map(|command| command.process)
            .collect();
        found.sort();
        found
    }

    #[test]
    fn a_turn_owns_the_commands_it_started_until_it_ends() {
        let mut commands = TurnCommands::default();
        commands.observe("item/started", &started("root", "t1", command("84650")));
        commands.observe("item/started", &started("root", "t1", command("71680")));
        commands.observe("item/started", &started("child", "c1", command("11")));
        commands.observe(
            "item/started",
            &started("root", "t1", json!({ "type": "agentMessage", "id": "m" })),
        );
        commands.observe(
            "item/started",
            &started(
                "root",
                "t1",
                json!({ "type": "commandExecution", "id": "x" }),
            ),
        );

        assert_eq!(processes(&commands, "root", Some("t1")), ["71680", "84650"]);
        // A command that exited is no longer Stop's; one Codex keeps running
        // past its item (no exit code) still is.
        let mut exited = command("71680");
        exited["exitCode"] = json!(0);
        commands.observe("item/completed", &started("root", "t1", exited));
        commands.observe("item/completed", &started("root", "t1", command("84650")));
        assert_eq!(processes(&commands, "root", Some("t1")), ["84650"]);
        assert!(processes(&commands, "root", Some("t0")).is_empty());
        assert_eq!(processes(&commands, "child", None), ["11"]);

        commands.observe(
            "turn/completed",
            &json!({ "threadId": "root", "turn": { "id": "t1", "status": "completed" } }),
        );
        assert!(processes(&commands, "root", None).is_empty());
        assert_eq!(processes(&commands, "child", None), ["11"]);
    }
}
