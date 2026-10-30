use crate::domain::agents::adapter::{RuntimeError, RuntimeSlashCommand, RuntimeSlashCommandKind};

use super::ClaudeCodeAdapter;

impl ClaudeCodeAdapter {
    pub(super) async fn discover_runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        // Filesystem entries are cwd-specific and re-scanned per call;
        // built-ins are cwd-invariant and cached. The two probes are
        // independent, so run them concurrently. Filesystem entries come
        // first so `resolve_commands`'s downstream first-seen dedup keeps
        // user-defined commands over identically-named built-ins.
        let (filesystem, builtins) = tokio::join!(
            claude_agent_sdk_rs::list_filesystem_commands(cwd),
            self.load_builtin_slash_commands(),
        );
        let filesystem = filesystem.map_err(RuntimeError::from)?;

        let mut commands: Vec<RuntimeSlashCommand> = filesystem
            .into_iter()
            .map(|command| RuntimeSlashCommand {
                name: command.name,
                description: command.description,
                kind: RuntimeSlashCommandKind::Command,
            })
            .collect();
        commands.extend(builtins);
        Ok(commands)
    }

    pub(super) fn slash_commands_cell(&self) -> &std::sync::RwLock<Vec<RuntimeSlashCommand>> {
        self.cached_slash_commands
            .get_or_init(|| std::sync::RwLock::new(Vec::new()))
    }

    /// Probe the CLI for its built-in slash commands once per process
    /// (retrying on empty results) and return the cached list. The SDK call
    /// is infallible — empty is the only "failure" mode we observe here.
    pub(super) async fn load_builtin_slash_commands(&self) -> Vec<RuntimeSlashCommand> {
        let mut guard = self.slash_commands_probe_state.lock().await;
        if !guard.live {
            let live: Vec<RuntimeSlashCommand> = claude_agent_sdk_rs::list_builtin_commands(None)
                .await
                .into_iter()
                .map(sdk_slash_to_runtime)
                .collect();
            if live.is_empty() {
                tracing::warn!(
                    "Claude Code CLI returned empty built-in slash-command list; will retry"
                );
            } else if let Ok(mut cached) = self.slash_commands_cell().write() {
                *cached = live;
                guard.live = true;
            }
        }
        drop(guard);
        self.slash_commands_cell()
            .read()
            .map(|commands| commands.clone())
            .unwrap_or_default()
    }
}

// Claude Code exposes skills and slash commands through the same init
// `slash_commands` list, so the adapter keeps them all as `/` commands.
fn sdk_slash_to_runtime(command: claude_agent_sdk_rs::SlashCommand) -> RuntimeSlashCommand {
    RuntimeSlashCommand {
        name: command.name,
        description: command.description,
        kind: RuntimeSlashCommandKind::Command,
    }
}
