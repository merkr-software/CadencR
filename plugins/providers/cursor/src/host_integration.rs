//! `host-integration`: what Cadencr may do for Cursor outside the ACP session.
//!
//! - Worktrees: the project-local Cursor configuration the built-in adapter
//!   copied into new worktrees.
//! - No `compactCommand`: Cursor Agent 2026.10.22's ACP server has no
//!   compaction command. `/compress` (the built-in adapter's compact prompt)
//!   and `/summarize` exist only in the interactive TUI; over ACP the text
//!   reaches the model as an ordinary prompt (verified live: the model
//!   searched the repository for what `/compress` means), and neither is in
//!   `available_commands_update`.
//! - No `resumeCommand`: the `sessionId` Cadencr stores is Cursor's ACP
//!   session id (passed through unchanged, also across access restarts, which
//!   `session/load` the same id). Cursor keeps ACP sessions in
//!   `~/.cursor/acp-sessions/<id>`, apart from interactive chats
//!   (`~/.cursor/chats/<workspace hash>/<id>`): `agent --resume <ACP id>`
//!   opens an empty chat under that id instead of the conversation (verified
//!   live), so advertising it would mislead.

use cadencr_provider_sdk::HostIntegration;

/// Project-local Cursor configuration copied into new worktrees.
pub const WORKTREE_CONFIG_PATHS: &[&str] = &[
    ".cursor/rules",
    ".cursor/commands",
    ".cursor/skills",
    ".cursor/mcp.json",
    ".cursor/cli.json",
];

pub fn cursor_host_integration() -> HostIntegration {
    HostIntegration::builder()
        .worktree_config_paths(
            WORKTREE_CONFIG_PATHS
                .iter()
                .map(|path| path.to_string())
                .collect(),
        )
        .build()
}

#[cfg(test)]
mod tests {
    use super::cursor_host_integration;
    use serde_json::json;

    #[test]
    fn declares_only_what_cursor_acp_supports() {
        let integration = cursor_host_integration();
        integration.validate().unwrap();
        assert_eq!(
            serde_json::to_value(integration).unwrap(),
            json!({
                "worktreeConfigPaths": [
                    ".cursor/rules", ".cursor/commands", ".cursor/skills",
                    ".cursor/mcp.json", ".cursor/cli.json"
                ]
            })
        );
    }
}
