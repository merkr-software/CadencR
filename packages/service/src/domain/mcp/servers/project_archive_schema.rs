use serde_json::{json, Value};

pub(super) const DESCRIPTION: &str = "Archive another conversation of the current project, with the same options the user has in CadencR's Archive dialog. It disappears from the sidebar's active list; its history is kept and the user can restore it from the archive. Optionally archive its spawn parent and/or descendants too, and clean up the selected conversation (not those relatives): kill its terminals, close its browser tabs, remove its worktree, delete its feature branch. You can't archive your own conversation, nor one whose agent is working or waiting on a gate. Cleanup runs after the archive and reports each step as done, skipped, pending, blocked, or failed — a blocked worktree (uncommitted changes) or branch (not merged) is only removed when you retry with the matching force flag, which permanently discards that work; a pending step waits on something else (browser tabs close once the desktop app connects, the branch waits for its worktree). The cleanup is recorded with the conversation: the user can also finish it from CadencR. Tell the user what you archived and removed.";

pub(super) fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "session_id": { "type": "number", "description": "Current-project session id whose conversation is archived (from project_list_sessions or a spawn result). Not your own." },
            "include_parent": { "type": "boolean", "default": false, "description": "Also archive the conversation that spawned or handed off to it. Refused when that is your own conversation." },
            "include_descendants": { "type": "boolean", "default": false, "description": "Also archive every conversation it spawned or handed off to, recursively." },
            "kill_terminals": { "type": "boolean", "default": false, "description": "Kill the shells running in its terminals." },
            "close_browser_tabs": { "type": "boolean", "default": false, "description": "Close its tabs in CadencR's browser (skipped when the desktop browser isn't available)." },
            "remove_worktree": { "type": "boolean", "default": false, "description": "Remove its worktree folder, keeping the branch. Skipped when it works in the main checkout." },
            "remove_branch": { "type": "boolean", "default": false, "description": "Delete its feature branch; also removes its worktree, which git requires first. A branch not merged into its target is only deleted with force_remove_branch. The default and target branches are never deleted." },
            "force_remove_worktree": { "type": "boolean", "default": false, "description": "Remove the worktree even with uncommitted or untracked changes, which are lost. Only after a blocked attempt and checking the changes aren't needed." },
            "force_remove_branch": { "type": "boolean", "default": false, "description": "Delete the branch even when it isn't merged into its target, losing its unmerged commits. Only after a blocked attempt and checking they aren't needed (e.g. a squash-merged PR)." }
        },
        "required": ["session_id"]
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn project_archive_session_mirrors_the_archive_dialog_options() {
        let tool = super::super::project_schema::tools()
            .into_iter()
            .find(|tool| tool.name == "project_archive_session")
            .expect("project_archive_session tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["required"], serde_json::json!(["session_id"]));
        for option in [
            "include_parent",
            "include_descendants",
            "kill_terminals",
            "close_browser_tabs",
            "remove_worktree",
            "remove_branch",
            "force_remove_worktree",
            "force_remove_branch",
        ] {
            assert_eq!(schema["properties"][option]["type"], "boolean", "{option}");
            assert_eq!(schema["properties"][option]["default"], false, "{option}");
        }
    }
}
