use crate::error::SdkError;
use crate::types::SlashCommand;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

mod builtins;
mod filesystem;
mod plugins;

#[derive(Default)]
struct CommandCollector {
    commands: Vec<SlashCommand>,
    seen: HashSet<String>,
}

impl CommandCollector {
    fn add(&mut self, name: impl Into<String>, description: Option<String>) {
        let name = name.into();
        if self.seen.insert(name.clone()) {
            self.commands.push(SlashCommand { name, description });
        }
    }

    fn into_commands(self) -> Vec<SlashCommand> {
        self.commands
    }
}

/// Every slash command available for `cwd`: filesystem entries first, then
/// built-ins. Built-ins are live-probed; the static catalog backs the probe.
pub async fn list_commands(
    cwd: &str,
    path_to_cli: Option<&Path>,
) -> Result<Vec<SlashCommand>, SdkError> {
    list_commands_with_home(cwd, home_dir(), path_to_cli).await
}

/// Filesystem-discovered commands and skills only. Built-ins are cwd-
/// invariant and excluded so callers can cache them independently.
pub async fn list_filesystem_commands(cwd: &str) -> Result<Vec<SlashCommand>, SdkError> {
    list_filesystem_commands_with_home(cwd, home_dir())
}

/// Built-in slash commands from the live CLI, falling back to the bundled
/// static catalog if the probe fails or returns empty. Bundled descriptions
/// also fill in for live entries the CLI omits a description for.
pub async fn list_builtin_commands(path_to_cli: Option<&Path>) -> Vec<SlashCommand> {
    let probe_cwd = std::env::temp_dir().to_string_lossy().into_owned();
    match crate::query::supported_commands(&probe_cwd, path_to_cli).await {
        Ok(live) if !live.is_empty() => {
            let descriptions = builtin_description_map();
            live.into_iter()
                .map(|command| SlashCommand {
                    description: command.description.or_else(|| {
                        descriptions
                            .get(command.name.as_str())
                            .map(|description| (*description).to_string())
                    }),
                    name: command.name,
                })
                .collect()
        }
        Ok(_) => {
            tracing::warn!(
                "Claude Code CLI returned empty commands list; falling back to static catalog"
            );
            static_builtin_commands()
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                "Claude Code built-in slash-command probe failed; falling back to static catalog"
            );
            static_builtin_commands()
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

async fn list_commands_with_home(
    cwd: &str,
    home: Option<PathBuf>,
    path_to_cli: Option<&Path>,
) -> Result<Vec<SlashCommand>, SdkError> {
    let mut collector = CommandCollector::default();
    filesystem::collect_filesystem_commands(&mut collector, cwd, home.as_deref())?;
    for command in list_builtin_commands(path_to_cli).await {
        collector.add(command.name, command.description);
    }
    Ok(collector.into_commands())
}

fn list_filesystem_commands_with_home(
    cwd: &str,
    home: Option<PathBuf>,
) -> Result<Vec<SlashCommand>, SdkError> {
    let mut collector = CommandCollector::default();
    filesystem::collect_filesystem_commands(&mut collector, cwd, home.as_deref())?;
    Ok(collector.into_commands())
}

fn builtin_description_map() -> HashMap<&'static str, &'static str> {
    builtins::BUILTIN_COMMANDS.iter().copied().collect()
}

fn static_builtin_commands() -> Vec<SlashCommand> {
    builtins::BUILTIN_COMMANDS
        .iter()
        .map(|(name, description)| SlashCommand {
            name: (*name).to_string(),
            description: Some((*description).to_string()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        list_builtin_commands, list_commands_with_home, list_filesystem_commands_with_home,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Forces `supported_commands` down its error path so tests exercise
    /// the static-catalog fallback. A literal nonexistent path doesn't work
    /// because `cli-discovery` falls through to PATH-based lookup when the
    /// override is missing, returning the host's real `claude`.
    fn install_exits_immediately_cli(dir: &TempDir) -> PathBuf {
        let script_path = dir.path().join("claude");
        fs::write(&script_path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).unwrap();
        script_path
    }

    /// A nonexistent CLI path, used by tests that only care about the
    /// filesystem half of `list_commands` and want the built-in probe to
    /// fail fast into the static fallback.
    fn missing_cli_path() -> PathBuf {
        PathBuf::from("/nonexistent/cadencr-test/claude-cli-that-does-not-exist")
    }

    #[tokio::test]
    async fn static_fallback_includes_documented_builtin_commands() {
        let dir = TempDir::new().unwrap();
        let cli = install_exits_immediately_cli(&dir);
        let commands = list_builtin_commands(Some(&cli)).await;

        let names: Vec<&str> = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect();
        assert!(names.contains(&"compact"));
        assert!(names.contains(&"help"));
        assert!(names.contains(&"plugin"));
        assert!(names.contains(&"simplify"));
    }

    #[tokio::test]
    async fn live_discovery_overrides_static_builtins() {
        let dir = TempDir::new().unwrap();
        let script_path = dir.path().join("claude");

        // Mock CLI emits an `initialize` control_response with three
        // commands covering the three merge cases: a live description that
        // overrides the static catalog (`compact`), a name absent from the
        // static catalog (`goal`), and a name with no live description
        // that should pick up the static fallback (`help`).
        let script = r#"#!/bin/sh
read -r INIT_REQ
REQ_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[{"name":"compact","description":"Live compact desc"},{"name":"goal","description":"Set a goal"},{"name":"help"}]}}}\n' "$REQ_ID"
exec sleep 60
"#;
        fs::write(&script_path, script).unwrap();
        let mut perms = fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).unwrap();

        let commands = list_builtin_commands(Some(&script_path)).await;

        let names: Vec<&str> = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect();
        assert_eq!(names, vec!["compact", "goal", "help"]);

        let compact = commands.iter().find(|c| c.name == "compact").unwrap();
        assert_eq!(
            compact.description.as_deref(),
            Some("Live compact desc"),
            "live description should win over the static catalog"
        );
        let goal = commands.iter().find(|c| c.name == "goal").unwrap();
        assert_eq!(
            goal.description.as_deref(),
            Some("Set a goal"),
            "live name unknown to the static catalog should keep its live description"
        );
        let help = commands.iter().find(|c| c.name == "help").unwrap();
        assert!(
            help.description
                .as_deref()
                .map(|d| !d.is_empty())
                .unwrap_or(false),
            "name missing a live description should fall back to the static catalog"
        );
    }

    #[tokio::test]
    async fn discovers_project_and_personal_commands_and_skills() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();

        fs::create_dir_all(workspace.path().join(".claude/commands/frontend")).unwrap();
        fs::write(
            workspace
                .path()
                .join(".claude/commands/frontend/component.md"),
            "---\ndescription: Build a component\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join(".claude/skills/review")).unwrap();
        fs::write(
            workspace.path().join(".claude/skills/review/SKILL.md"),
            "---\ndescription: Review project changes\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".claude/commands")).unwrap();
        fs::write(
            home.path().join(".claude/commands/security-review.md"),
            "Review security issues",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".claude/skills/commit")).unwrap();
        fs::write(
            home.path().join(".claude/skills/commit/SKILL.md"),
            "---\ndescription: Create a commit\n---\nBody",
        )
        .unwrap();

        let commands = list_filesystem_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
        )
        .unwrap();

        let component = commands
            .iter()
            .find(|command| command.name == "component")
            .unwrap();
        assert_eq!(component.description.as_deref(), Some("Build a component"));
        assert!(commands.iter().any(|command| command.name == "review"));
        assert!(commands
            .iter()
            .any(|command| command.name == "security-review"));
        assert!(commands.iter().any(|command| command.name == "commit"));
    }

    #[tokio::test]
    async fn discovers_symlinked_project_skills() {
        use std::os::unix::fs::symlink;

        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let shared_skill = workspace.path().join(".agents/skills/qa");
        fs::create_dir_all(&shared_skill).unwrap();
        fs::write(
            shared_skill.join("SKILL.md"),
            "---\ndescription: Run project QA\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join(".claude/skills")).unwrap();
        symlink(
            std::path::Path::new("../../.agents/skills/qa"),
            workspace.path().join(".claude/skills/qa"),
        )
        .unwrap();

        let commands = list_filesystem_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
        )
        .unwrap();

        let qa = commands
            .iter()
            .find(|command| command.name == "qa")
            .unwrap();
        assert_eq!(qa.description.as_deref(), Some("Run project QA"));
    }

    #[tokio::test]
    async fn lists_custom_and_plugin_commands_before_builtins() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();

        fs::create_dir_all(workspace.path().join(".claude/skills/project-skill")).unwrap();
        fs::write(
            workspace
                .path()
                .join(".claude/skills/project-skill/SKILL.md"),
            "---\ndescription: Project skill\n---\nBody",
        )
        .unwrap();
        let plugin_root = home
            .path()
            .join(".claude/plugins/cache/test-market/superpowers/1.0.0");
        fs::create_dir_all(plugin_root.join("skills/brainstorming")).unwrap();
        fs::write(
            plugin_root.join("skills/brainstorming/SKILL.md"),
            "---\ndescription: Brainstorm\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".claude/plugins")).unwrap();
        fs::write(
            home.path().join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"superpowers@test-market":[{{"installPath":"{}"}}]}}}}"#,
                plugin_root.display()
            ),
        )
        .unwrap();

        // Force the static-catalog fallback so `compact` reliably appears
        // from the built-in slice (the live-CLI probe is non-deterministic
        // in the test environment).
        let commands = list_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
            Some(&missing_cli_path()),
        )
        .await
        .unwrap();

        let custom_index = commands
            .iter()
            .position(|command| command.name == "project-skill")
            .unwrap();
        let plugin_index = commands
            .iter()
            .position(|command| command.name == "superpowers:brainstorming")
            .unwrap();
        let compact_index = commands
            .iter()
            .position(|command| command.name == "compact")
            .unwrap();

        assert!(custom_index < compact_index);
        assert!(plugin_index < compact_index);
    }

    #[tokio::test]
    async fn description_parser_ignores_non_description_frontmatter_fields() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();

        fs::create_dir_all(workspace.path().join(".claude/commands")).unwrap();
        fs::write(
            workspace.path().join(".claude/commands/commit.md"),
            "---\nallowed-tools: Bash(git status:*)\nmodel: sonnet\ndescription: Commit changes\n---\nBody",
        )
        .unwrap();

        let commands = list_filesystem_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
        )
        .unwrap();

        let commit = commands
            .iter()
            .find(|command| command.name == "commit")
            .unwrap();
        assert_eq!(commit.description.as_deref(), Some("Commit changes"));
    }

    #[tokio::test]
    async fn dangling_command_symlink_does_not_fail_discovery() {
        use std::os::unix::fs::symlink;

        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let commands_dir = home.path().join(".claude/commands");
        fs::create_dir_all(&commands_dir).unwrap();
        symlink(
            home.path().join("missing-source.md"),
            commands_dir.join("missing.md"),
        )
        .unwrap();

        let commands = list_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
            Some(&missing_cli_path()),
        )
        .await
        .unwrap();

        assert!(commands.iter().any(|command| command.name == "compact"));
        assert!(!commands.iter().any(|command| command.name == "missing"));
    }

    #[tokio::test]
    async fn discovers_enabled_plugin_commands_from_manifest_install_paths() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let plugin_root = home
            .path()
            .join(".claude/plugins/cache/test-market/superpowers/1.0.0");

        fs::create_dir_all(plugin_root.join("commands")).unwrap();
        fs::write(
            plugin_root.join("commands/plan.md"),
            "---\ndescription: Plan with superpowers\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(plugin_root.join("skills/debug")).unwrap();
        fs::write(
            plugin_root.join("skills/debug/SKILL.md"),
            "---\ndescription: Debug with superpowers\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".claude/plugins")).unwrap();
        fs::write(
            home.path().join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{
                  "version": 2,
                  "plugins": {{
                    "superpowers@test-market": [{{
                      "scope": "user",
                      "installPath": "{}",
                      "version": "1.0.0",
                      "lastUpdated": "2026-05-05T00:00:00.000Z"
                    }}]
                  }}
                }}"#,
                plugin_root.display()
            ),
        )
        .unwrap();

        let commands = list_filesystem_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
        )
        .unwrap();

        let plan = commands
            .iter()
            .find(|command| command.name == "superpowers:plan")
            .unwrap();
        assert_eq!(plan.description.as_deref(), Some("Plan with superpowers"));
        assert!(commands
            .iter()
            .any(|command| command.name == "superpowers:debug"));
    }

    #[tokio::test]
    async fn discovers_multiple_marketplace_plugin_skills() {
        let workspace = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let plugin_root = home
            .path()
            .join(".claude/plugins/cache/claude-plugins-official/superpowers/5.1.0");

        for skill in [
            "brainstorming",
            "systematic-debugging",
            "test-driven-development",
        ] {
            fs::create_dir_all(plugin_root.join("skills").join(skill)).unwrap();
            fs::write(
                plugin_root.join("skills").join(skill).join("SKILL.md"),
                format!("---\ndescription: {skill}\n---\nBody"),
            )
            .unwrap();
        }
        fs::create_dir_all(home.path().join(".claude/plugins")).unwrap();
        fs::write(
            home.path().join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"superpowers@claude-plugins-official":[{{"installPath":"{}"}}]}}}}"#,
                plugin_root.display()
            ),
        )
        .unwrap();

        let commands = list_filesystem_commands_with_home(
            workspace.path().to_str().unwrap(),
            Some(home.path().to_path_buf()),
        )
        .unwrap();

        for name in [
            "superpowers:brainstorming",
            "superpowers:systematic-debugging",
            "superpowers:test-driven-development",
        ] {
            assert!(
                commands.iter().any(|command| command.name == name),
                "missing {name}"
            );
        }
    }
}
