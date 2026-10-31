//! Model and effort a custom Claude Code agent definition pins.
//!
//! Effort never reaches the wire, and the Agent tool input names only
//! overrides. For a `subagent_type` naming a custom agent, the adapter reads
//! that agent's frontmatter (`model`, `effort`) where the CLI finds it: the
//! nearest `.claude/agents/<name>.md` walking up from the session's working
//! directory, then the user's `~/.claude/agents/<name>.md`. Input overrides
//! win, so the file is read only for the fields the launch left unset, once
//! per launch. Built-in agents have no file and resolve to nothing.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tracing::warn;

use crate::domain::agents::adapter::{RuntimeSubagentPatch, RuntimeSubagentUpdate};

/// Fields one launch still needs from its agent definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DefinitionLookup {
    tool_use_id: String,
    agent_type: String,
    want_model: bool,
    want_effort: bool,
}

impl DefinitionLookup {
    /// `None` when the input names no definition or already sets both fields.
    pub(super) fn for_launch(tool_use_id: &str, input: &Value) -> Option<Self> {
        let requested = RuntimeSubagentPatch::from_tool_input(input);
        let agent_type = requested
            .agent_type
            .filter(|name| is_definition_name(name))?;
        let want_model = input.get("model").and_then(Value::as_str).is_none();
        let want_effort = requested.reasoning_effort.is_none();
        (want_model || want_effort).then(|| Self {
            tool_use_id: tool_use_id.to_string(),
            agent_type,
            want_model,
            want_effort,
        })
    }
}

/// Where agent definitions live for one session.
#[derive(Debug, Clone, Default)]
pub(super) struct AgentDirs {
    roots: Vec<PathBuf>,
}

impl AgentDirs {
    /// `cwd` must be absolute; a relative one would resolve against the
    /// service's own directory, so it is ignored.
    pub(super) fn new(cwd: &Path, home: Option<&Path>) -> Self {
        let mut roots: Vec<PathBuf> = if cwd.is_absolute() {
            cwd.ancestors()
                .take_while(|dir| Some(*dir) != home)
                .map(|dir| dir.join(".claude").join("agents"))
                .collect()
        } else {
            Vec::new()
        };
        if let Some(home) = home {
            roots.push(home.join(".claude").join("agents"));
        }
        Self { roots }
    }

    pub(super) async fn resolve(&self, lookup: &DefinitionLookup) -> Option<RuntimeSubagentUpdate> {
        let frontmatter = self.read(&lookup.agent_type).await?;
        let patch = RuntimeSubagentPatch {
            model: frontmatter.model.filter(|_| lookup.want_model),
            reasoning_effort: frontmatter.effort.filter(|_| lookup.want_effort),
            ..RuntimeSubagentPatch::default()
        };
        (!patch.is_empty()).then(|| RuntimeSubagentUpdate::new(&lookup.tool_use_id, patch))
    }

    async fn read(&self, name: &str) -> Option<AgentFrontmatter> {
        let file = format!("{name}.md");
        for root in &self.roots {
            let path = root.join(&file);
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => return Some(parse_frontmatter(&content)),
                Err(error) if is_absent(&error) => continue,
                Err(error) => {
                    warn!(
                        path = %path.display(),
                        %error,
                        "claude adapter: could not read agent definition; sub-agent model/effort left unknown"
                    );
                    return None;
                }
            }
        }
        None
    }
}

fn is_absent(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// Plain agent names only: no plugin namespaces (`plugin:agent`) and nothing
/// that could step outside the agents directory.
fn is_definition_name(name: &str) -> bool {
    name.len() <= 128
        && !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AgentFrontmatter {
    model: Option<String>,
    effort: Option<String>,
}

/// Top-level `model` / `effort` scalars of a `---` fenced YAML frontmatter.
fn parse_frontmatter(content: &str) -> AgentFrontmatter {
    let mut frontmatter = AgentFrontmatter::default();
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return frontmatter;
    }
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "model" => frontmatter.model = scalar(value).filter(|model| model != "inherit"),
            "effort" => frontmatter.effort = scalar(value),
            _ => {}
        }
    }
    frontmatter
}

fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    let value = match value.chars().next() {
        Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().unwrap_or_default(),
        _ => value.split(" #").next().unwrap_or_default(),
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::{parse_frontmatter, AgentDirs, AgentFrontmatter, DefinitionLookup};

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn parses_model_and_effort_from_frontmatter() {
        let content = "---\nname: reviewer\ndescription: \"Reviews: code\"\nmodel: sonnet # fast\neffort: 'high'\ntools:\n  - Read\n---\nYou review code.\nmodel: opus\n";
        assert_eq!(
            parse_frontmatter(content),
            AgentFrontmatter {
                model: Some("sonnet".into()),
                effort: Some("high".into()),
            }
        );
    }

    #[test]
    fn inherit_numeric_effort_and_missing_fence() {
        assert_eq!(
            parse_frontmatter("---\r\nmodel: inherit\r\neffort: 3\r\n---\r\n"),
            AgentFrontmatter {
                model: None,
                effort: Some("3".into()),
            }
        );
        assert_eq!(
            parse_frontmatter("model: opus\n"),
            AgentFrontmatter::default()
        );
    }

    #[test]
    fn lookup_only_for_fields_the_input_left_unset() {
        let both = DefinitionLookup::for_launch("t1", &json!({"subagent_type": "reviewer"}));
        assert!(both.as_ref().is_some_and(|l| l.want_model && l.want_effort));
        let effort_only = DefinitionLookup::for_launch(
            "t1",
            &json!({"subagent_type": "reviewer", "model": "haiku"}),
        )
        .unwrap();
        assert!(!effort_only.want_model && effort_only.want_effort);
        assert_eq!(
            DefinitionLookup::for_launch(
                "t1",
                &json!({"subagent_type": "reviewer", "model": "haiku", "effort": "low"})
            ),
            None
        );
        assert_eq!(
            DefinitionLookup::for_launch("t1", &json!({"prompt": "p"})),
            None
        );
        for name in ["../secrets", "plugin:agent", "a/b", ""] {
            assert_eq!(
                DefinitionLookup::for_launch("t1", &json!({"subagent_type": name})),
                None,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn nearest_project_definition_wins_then_user_definition() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("work").join("repo");
        let cwd = project.join("packages").join("app");
        std::fs::create_dir_all(&cwd).unwrap();
        write(
            &root.path().join("work/.claude/agents/reviewer.md"),
            "---\nmodel: opus\neffort: max\n---\n",
        );
        write(
            &project.join(".claude/agents/reviewer.md"),
            "---\nmodel: haiku\n---\n",
        );
        write(
            &home.join(".claude/agents/planner.md"),
            "---\nmodel: sonnet\neffort: low\n---\n",
        );
        let dirs = AgentDirs::new(&cwd, Some(&home));

        let lookup = DefinitionLookup::for_launch("t1", &json!({"subagent_type": "reviewer"}));
        let update = dirs.resolve(&lookup.unwrap()).await.unwrap();
        assert_eq!(update.tool_use_id, "t1");
        assert_eq!(update.patch.model.as_deref(), Some("haiku"));
        assert!(!update.patch.model_resolved);
        // The nearest file wins whole: no effort merged from a farther one.
        assert_eq!(update.patch.reasoning_effort, None);

        let lookup = DefinitionLookup::for_launch(
            "t2",
            &json!({"subagent_type": "planner", "model": "opus"}),
        );
        let update = dirs.resolve(&lookup.unwrap()).await.unwrap();
        assert_eq!(update.patch.model, None);
        assert_eq!(update.patch.reasoning_effort.as_deref(), Some("low"));

        let lookup = DefinitionLookup::for_launch("t3", &json!({"subagent_type": "Explore"}));
        assert_eq!(dirs.resolve(&lookup.unwrap()).await, None);
    }

    #[tokio::test]
    async fn relative_cwd_is_not_searched() {
        let dirs = AgentDirs::new(Path::new("relative/dir"), None);
        let lookup = DefinitionLookup::for_launch("t1", &json!({"subagent_type": "reviewer"}));
        assert_eq!(dirs.resolve(&lookup.unwrap()).await, None);
    }
}
