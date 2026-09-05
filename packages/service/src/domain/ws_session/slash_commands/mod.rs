use std::collections::HashSet;
use std::time::Duration;

use tracing::{debug, warn};

use crate::domain::agents::adapter::{RuntimeSlashCommand, RuntimeSlashCommandKind};
use crate::domain::agents::runtime_adapter;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub kind: SlashCommandKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashCommandKind {
    Command,
    Skill,
    /// A Cadencr virtual orchestration skill (`/cadencr:*`). Not installed on
    /// any provider — Cadencr surfaces it in the menu and expands it into the
    /// prompt at send time. The FE renders these specially and disables them
    /// when the project MCP they depend on is off.
    Cadencr,
}

impl From<RuntimeSlashCommandKind> for SlashCommandKind {
    fn from(kind: RuntimeSlashCommandKind) -> Self {
        match kind {
            RuntimeSlashCommandKind::Command => Self::Command,
            RuntimeSlashCommandKind::Skill => Self::Skill,
        }
    }
}

pub async fn resolve_commands(cwd: &str, provider: &str) -> Vec<SlashCommand> {
    let mut commands = Vec::new();
    let mut seen = HashSet::new();

    merge_commands(&mut commands, &mut seen, builtin_commands(provider));

    let Some(adapter) = runtime_adapter(provider) else {
        return commands;
    };

    // Cadencr's virtual orchestration skills are provider-neutral and only
    // meaningful inside a real session, so they're added once an adapter is
    // resolved (an unknown provider gets none).
    merge_commands(&mut commands, &mut seen, orchestration_skill_commands());

    const COMMANDS_TIMEOUT: Duration = Duration::from_secs(15);
    match tokio::time::timeout(COMMANDS_TIMEOUT, adapter.runtime_slash_commands(cwd)).await {
        Ok(inner) => match inner {
            Ok(native_commands) => {
                merge_commands(&mut commands, &mut seen, to_slash_commands(native_commands));
            }
            Err(error) => {
                warn!(
                    cwd,
                    error = %error,
                    "failed to load commands from runtime provider"
                );
            }
        },
        Err(_) => {
            warn!(
                cwd,
                timeout_secs = COMMANDS_TIMEOUT.as_secs(),
                "slash-command probe timed out"
            );
        }
    }
    commands
}

/// Provider-specific built-in slash commands that aren't discovered through
/// filesystem scanning. Kept isolated per provider to avoid spreading
/// provider-specific branching through the generic resolver.
fn builtin_commands(provider: &str) -> Vec<SlashCommand> {
    let Some(adapter) = runtime_adapter(provider) else {
        return Vec::new();
    };
    let mut commands = Vec::new();
    if adapter.supports_builtin_compact_command() {
        commands.push(compact_command());
    }
    if provider == crate::domain::agents::codex::PROVIDER_ID {
        commands.extend(codex_app_builtin_commands());
    }
    commands
}

fn compact_command() -> SlashCommand {
    SlashCommand {
        name: "compact".to_string(),
        description: Some(
            "Compact the conversation, freeing context while keeping a summary".to_string(),
        ),
        kind: SlashCommandKind::Command,
    }
}

/// Hand-maintained: Codex's app-server protocol has no `commands/list` RPC
/// (verified via `codex app-server generate-json-schema`), so we can't
/// discover these the way we do Claude Code's built-ins.
fn codex_app_builtin_commands() -> Vec<SlashCommand> {
    [
        (
            "feedback",
            "Open a form to send feedback about the current Codex session",
        ),
        ("goal", "set or view the goal for a long-running task"),
        (
            "mcp",
            "Show configured Model Context Protocol servers and tools",
        ),
        (
            "plan-mode",
            "Ask Codex to plan first and wait for approval before editing",
        ),
        ("review", "Review the current code changes"),
        ("status", "Show Codex session and environment status"),
    ]
    .into_iter()
    .map(|(name, description)| SlashCommand {
        name: name.to_string(),
        description: Some(description.to_string()),
        kind: SlashCommandKind::Command,
    })
    .collect()
}

/// Cadencr's virtual `/cadencr:*` orchestration skills as menu entries. Sourced
/// from the single catalog in `domain::agents::orchestration_skills`.
fn orchestration_skill_commands() -> Vec<SlashCommand> {
    crate::domain::agents::orchestration_skills::ORCHESTRATION_SKILLS
        .iter()
        .map(|skill| SlashCommand {
            name: skill.command(),
            description: Some(skill.description.to_string()),
            kind: SlashCommandKind::Cadencr,
        })
        .collect()
}

fn to_slash_commands(commands: Vec<RuntimeSlashCommand>) -> Vec<SlashCommand> {
    commands
        .into_iter()
        .map(|command| SlashCommand {
            name: command.name,
            description: command.description,
            kind: command.kind.into(),
        })
        .collect()
}

fn merge_commands(
    resolved: &mut Vec<SlashCommand>,
    seen: &mut HashSet<String>,
    candidates: Vec<SlashCommand>,
) {
    for command in candidates {
        if seen.insert(command.name.clone()) {
            debug!(name = %command.name, "resolved slash command");
            resolved.push(command);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{builtin_commands, merge_commands, SlashCommand, SlashCommandKind};

    #[test]
    fn builtin_commands_injects_compact_for_supported_providers() {
        for provider in [
            crate::domain::agents::opencode::PROVIDER_ID,
            crate::domain::agents::codex::PROVIDER_ID,
        ] {
            let commands = builtin_commands(provider);
            assert!(commands.iter().any(|command| command.name == "compact"));
        }
    }

    #[test]
    fn builtin_commands_is_empty_for_other_providers() {
        assert!(builtin_commands("openai").is_empty());
    }

    #[test]
    fn builtin_commands_injects_codex_app_commands() {
        let commands = builtin_commands(crate::domain::agents::codex::PROVIDER_ID);
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "compact",
                "feedback",
                "goal",
                "mcp",
                "plan-mode",
                "review",
                "status"
            ]
        );
    }

    #[tokio::test]
    async fn unknown_provider_does_not_use_local_filesystem_discovery() {
        let temp = tempfile::TempDir::new().unwrap();
        let commands_dir = temp.path().join(".opencode/commands");
        std::fs::create_dir_all(&commands_dir).unwrap();
        std::fs::write(
            commands_dir.join("leaked.md"),
            "---\ndescription: leaked\n---\n",
        )
        .unwrap();

        let commands = super::resolve_commands(temp.path().to_str().unwrap(), "unknown").await;

        assert!(commands.is_empty());
    }

    #[tokio::test]
    async fn codex_provider_does_not_scan_foreign_local_command_roots() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        let opencode_commands = temp.path().join(".opencode/commands");
        std::fs::create_dir_all(&opencode_commands).unwrap();
        std::fs::write(opencode_commands.join("item-add.md"), "OpenCode only").unwrap();

        let commands = super::resolve_commands(
            temp.path().to_str().unwrap(),
            crate::domain::agents::codex::PROVIDER_ID,
        )
        .await;

        assert!(commands.iter().any(|command| command.name == "compact"));
        assert!(!commands.iter().any(|command| command.name == "item-add"));
    }

    #[test]
    fn orchestration_skill_commands_are_namespaced_cadencr_kind() {
        let skills = super::orchestration_skill_commands();
        let names = skills
            .iter()
            .map(|command| command.name.clone())
            .collect::<Vec<_>>();
        let expected = crate::domain::agents::orchestration_skills::ORCHESTRATION_SKILLS
            .iter()
            .map(|skill| skill.command())
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
        assert!(skills
            .iter()
            .all(|c| matches!(c.kind, SlashCommandKind::Cadencr)));
    }

    #[tokio::test]
    async fn resolve_commands_includes_virtual_skills_for_a_real_provider() {
        let temp = tempfile::TempDir::new().unwrap();
        let commands = super::resolve_commands(
            temp.path().to_str().unwrap(),
            crate::domain::agents::codex::PROVIDER_ID,
        )
        .await;
        assert!(commands
            .iter()
            .any(|c| c.name == "cadencr:status" && matches!(c.kind, SlashCommandKind::Cadencr)));
    }

    #[test]
    fn merge_commands_keeps_first_description() {
        let mut resolved = vec![SlashCommand {
            name: "review".to_string(),
            description: Some("OpenCode review".to_string()),
            kind: SlashCommandKind::Command,
        }];
        let mut seen = HashSet::from(["review".to_string()]);

        merge_commands(
            &mut resolved,
            &mut seen,
            vec![SlashCommand {
                name: "review".to_string(),
                description: Some("Fallback review".to_string()),
                kind: SlashCommandKind::Skill,
            }],
        );

        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].description.as_deref(), Some("OpenCode review"));
    }
}
