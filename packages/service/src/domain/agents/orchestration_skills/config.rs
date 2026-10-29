//! The session configuration a user pins for a spawning virtual skill.
//!
//! The composer's skill wizard writes the choices as leading `--key=value`
//! flags right after the command (`/cadencr:review --model=… branch`), which
//! keeps them visible in the transcript and lets a power user type them by
//! hand. Expansion strips the flags from `$ARGUMENTS` and appends a section the
//! agent must honor in every `project_spawn_session` call.

use serde::Serialize;
use utoipa::ToSchema;

/// Where a spawned session works, relative to the invoking conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillWorktree {
    /// The invoking conversation's own worktree (sees its uncommitted work).
    Same,
    /// A fresh worktree on a new branch forked from the current one.
    New,
    /// The project's main checkout, without a worktree.
    Project,
}

impl SkillWorktree {
    fn flag_value(self) -> &'static str {
        match self {
            Self::Same => "same",
            Self::New => "new",
            Self::Project => "project",
        }
    }

    fn from_flag(value: &str) -> Option<Self> {
        [Self::Same, Self::New, Self::Project]
            .into_iter()
            .find(|worktree| worktree.flag_value() == value)
    }

    fn spawn_branch(self) -> &'static str {
        match self {
            Self::Same => {
                "`{ \"mode\": \"reuse_worktree\", \"reuse_branch\": \"<current branch>\" }` \
                 — the same worktree as this conversation"
            }
            Self::New => {
                "`{ \"mode\": \"new_worktree\", \"base\": \"<current branch>\" }` \
                 — a fresh worktree on a new branch from the current one"
            }
            Self::Project => "`{ \"mode\": \"none\" }` — the project's main checkout, no worktree",
        }
    }
}

/// What a skill lets the user configure before it runs. A skill with no
/// parameters gets no wizard.
#[derive(Debug, Clone, Copy)]
pub struct SkillParameters {
    /// Provider, model, thinking level and permission mode of spawned sessions.
    pub agent: bool,
    /// Offered worktree placements; the first is the skill's default. The
    /// wizard only shows a choice when there are at least two.
    pub worktrees: &'static [SkillWorktree],
}

impl SkillParameters {
    pub const NONE: Self = Self {
        agent: false,
        worktrees: &[],
    };

    pub fn is_empty(&self) -> bool {
        !self.agent && self.worktrees.len() < 2
    }
}

/// The values parsed from an invocation's leading flags.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SkillConfig {
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    mode: Option<String>,
    worktree: Option<SkillWorktree>,
}

impl SkillConfig {
    /// Consume the leading `--key=value` flags `parameters` allows, returning
    /// the configuration and the remaining argument text. Parsing stops at the
    /// first token that isn't an allowed flag, so free-form arguments that
    /// merely contain `--` pass through untouched. A repeated flag keeps its
    /// last value.
    pub(super) fn parse<'a>(args: &'a str, parameters: &SkillParameters) -> (Self, &'a str) {
        let mut config = Self::default();
        let mut rest = args.trim_start();
        while let Some(flag) = rest.strip_prefix("--") {
            let end = flag.find(char::is_whitespace).unwrap_or(flag.len());
            let Some((key, value)) = flag[..end].split_once('=') else {
                break;
            };
            if value.is_empty() || !config.set(key, value, parameters) {
                break;
            }
            rest = flag[end..].trim_start();
        }
        (config, rest)
    }

    fn set(&mut self, key: &str, value: &str, parameters: &SkillParameters) -> bool {
        // Values land in the prompt inside code spans the agent must obey: only
        // id-shaped values (`opus[1m]`, `anthropic/claude-x`, `acceptEdits`).
        if !value.chars().all(is_id_char) {
            return false;
        }
        let value = value.to_string();
        match key {
            "provider" if parameters.agent => self.provider = Some(value),
            "model" if parameters.agent => self.model = Some(value),
            "thinking" if parameters.agent => self.thinking = Some(value),
            "mode" if parameters.agent => self.mode = Some(value),
            "worktree" => match SkillWorktree::from_flag(&value) {
                Some(worktree) if parameters.worktrees.contains(&worktree) => {
                    self.worktree = Some(worktree)
                }
                _ => return false,
            },
            _ => return false,
        }
        true
    }

    /// The section appended to the expanded prompt, or `None` when nothing
    /// was pinned.
    pub(super) fn render(&self) -> Option<String> {
        let mut lines = Vec::new();
        let mut push = |parameter: &str, value: &Option<String>| {
            if let Some(value) = value {
                lines.push(format!("- `{parameter}`: `{value}`"));
            }
        };
        push("provider", &self.provider);
        push("model", &self.model);
        push("thinking_level", &self.thinking);
        push("permission_mode", &self.mode);
        if let Some(worktree) = self.worktree {
            lines.push(format!("- `branch`: {}", worktree.spawn_branch()));
        }
        if lines.is_empty() {
            return None;
        }
        Some(format!(
            "## Session configuration chosen by the user\n\n\
             The user configured the sessions this workflow spawns. Pass these values to \
             every `project_spawn_session` call; they override any default or \
             recommendation above, and you must not second-guess them:\n\n{}\n\n\
             Choose every other parameter as described above.",
            lines.join("\n")
        ))
    }
}

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@' | '[' | ']')
}

#[cfg(test)]
mod tests {
    use super::{SkillConfig, SkillParameters, SkillWorktree};

    const ALL: SkillParameters = SkillParameters {
        agent: true,
        worktrees: &[
            SkillWorktree::Same,
            SkillWorktree::New,
            SkillWorktree::Project,
        ],
    };

    #[test]
    fn parse_consumes_leading_flags_and_keeps_the_arguments() {
        let (config, rest) = SkillConfig::parse(
            " --provider=codex --model=gpt-5 --thinking=high --mode=plan --worktree=new branch",
            &ALL,
        );
        assert_eq!(rest, "branch");
        assert_eq!(
            config,
            SkillConfig {
                provider: Some("codex".into()),
                model: Some("gpt-5".into()),
                thinking: Some("high".into()),
                mode: Some("plan".into()),
                worktree: Some(SkillWorktree::New),
            }
        );
    }

    #[test]
    fn parse_stops_at_the_first_unknown_or_disallowed_token() {
        let (config, rest) = SkillConfig::parse("--model=opus fix the --model=x flag", &ALL);
        assert_eq!(config.model.as_deref(), Some("opus"));
        assert_eq!(rest, "fix the --model=x flag");

        // A skill without agent parameters leaves agent flags in the arguments.
        let worktree_only = SkillParameters {
            agent: false,
            worktrees: &[SkillWorktree::Same, SkillWorktree::New],
        };
        let (config, rest) = SkillConfig::parse("--model=opus x", &worktree_only);
        assert_eq!(config, SkillConfig::default());
        assert_eq!(rest, "--model=opus x");

        // A worktree the skill doesn't offer is not consumed.
        let (_, rest) = SkillConfig::parse("--worktree=project x", &worktree_only);
        assert_eq!(rest, "--worktree=project x");

        for args in ["--model x", "--model= x", "--verbose=1 x"] {
            let (config, rest) = SkillConfig::parse(args, &ALL);
            assert_eq!(config, SkillConfig::default(), "{args}");
            assert_eq!(rest, args, "{args}");
        }
    }

    #[test]
    fn parse_refuses_values_that_are_not_ids() {
        // A backtick or quote would break out of the rendered code span.
        for args in ["--model=a`b x", "--model=\"opus\" x", "--mode=plan*now x"] {
            let (config, rest) = SkillConfig::parse(args, &ALL);
            assert_eq!(config, SkillConfig::default(), "{args}");
            assert_eq!(rest, args, "{args}");
        }
        let (config, _) = SkillConfig::parse("--model=opus[1m] --provider=open_code", &ALL);
        assert_eq!(config.model.as_deref(), Some("opus[1m]"));
        let (config, _) = SkillConfig::parse("--model=anthropic/claude-x@2025", &ALL);
        assert_eq!(config.model.as_deref(), Some("anthropic/claude-x@2025"));
    }

    #[test]
    fn parse_keeps_the_last_repeated_flag() {
        let (config, rest) = SkillConfig::parse("--model=a --model=b", &ALL);
        assert_eq!(config.model.as_deref(), Some("b"));
        assert_eq!(rest, "");
    }

    #[test]
    fn render_lists_only_pinned_values() {
        assert_eq!(SkillConfig::default().render(), None);
        let (config, _) = SkillConfig::parse("--model=opus --worktree=project", &ALL);
        let section = config.render().unwrap();
        assert!(section.starts_with("## Session configuration chosen by the user"));
        assert!(section.contains("- `model`: `opus`"));
        assert!(section.contains("`{ \"mode\": \"none\" }`"));
        assert!(!section.contains("`provider`"));
        assert!(!section.contains("thinking_level"));
    }

    #[test]
    fn empty_parameters_mean_no_wizard() {
        assert!(SkillParameters::NONE.is_empty());
        let single = SkillParameters {
            agent: false,
            worktrees: &[SkillWorktree::New],
        };
        assert!(single.is_empty());
        assert!(!ALL.is_empty());
    }
}
