//! Provider-neutral catalog of the `/cadencr:*` **virtual** skills: the
//! orchestration workflows plus `visualize` (charts and HTML visuals the chat
//! renders inline).
//!
//! These are *not* installed into any provider (no files written into user
//! repos): they only exist inside Cadencr. Cadencr advertises them in the
//! composer's slash menu, and when one is invoked it expands the skill's prompt
//! body into the outgoing message before it reaches the agent. This keeps them
//! from leaking into a repo where they'd be broken — the skills only work while
//! Cadencr's project/workspace MCP tools are attached.
//!
//! This module is the single source of truth (name, description, prompt body);
//! it never branches on provider identity.

use std::borrow::Cow;

mod config;
pub mod routes;

use config::SkillConfig;
pub use config::{SkillParameters, SkillWorktree};

/// Prefix that namespaces every virtual skill, e.g. `cadencr:review`.
pub const ORCHESTRATION_SKILL_PREFIX: &str = "cadencr:";

/// Shared boundary prepended to every expanded workflow.
const PORTABLE_WORKFLOW_BOUNDARY: &str = include_str!("prompts/workflow_boundary.md");
/// Additional boundary for workflows that can receive a pushed child completion.
const CHILD_COMPLETION_BOUNDARY: &str = include_str!("prompts/child_completion_boundary.md");

/// Shared text expanded ahead of a skill's own body.
enum Preamble {
    /// An orchestration workflow driven by the CadencR MCP tools.
    Workflow,
    /// A workflow that can also receive a pushed child final message.
    FollowedWorkflow,
    /// Self-contained guidance that needs no MCP tools.
    SelfContained,
}

/// One virtual skill, surfaced as `/cadencr:<name>`.
pub struct OrchestrationSkill {
    /// Bare skill name; the surfaced command is `cadencr:<name>`.
    pub name: &'static str,
    /// One-line description used as the menu hint.
    pub description: &'static str,
    /// Full description the composer's skill wizard shows before it runs.
    pub details: &'static str,
    /// What the free-form text after the command means, if anything.
    pub argument_hint: Option<&'static str>,
    /// What the user can pin before it runs (`config::SkillConfig` flags).
    pub parameters: SkillParameters,
    /// Prompt body expanded into the outgoing message when the skill runs.
    pub body: &'static str,
    preamble: Preamble,
}

impl OrchestrationSkill {
    /// The namespaced command token, e.g. `cadencr:review`.
    pub fn command(&self) -> String {
        format!("{ORCHESTRATION_SKILL_PREFIX}{}", self.name)
    }

    /// Expand this skill into the prompt text sent to the agent. Any trailing
    /// argument string the user typed after the command replaces the
    /// `$ARGUMENTS` placeholder the prompt bodies reference (the standard
    /// slash-command convention); with no arguments the placeholder collapses
    /// to empty. Leading configuration flags are consumed first and rendered
    /// as a section after the body.
    fn expand(&self, args: &str) -> String {
        let (config, args) = SkillConfig::parse(args, &self.parameters);
        let body = self.body.replace("$ARGUMENTS", args.trim());
        let body = match config.render() {
            Some(section) => format!("{body}\n\n{section}"),
            None => body,
        };
        match self.preamble {
            Preamble::FollowedWorkflow => {
                format!("{PORTABLE_WORKFLOW_BOUNDARY}\n\n{CHILD_COMPLETION_BOUNDARY}\n\n{body}")
            }
            Preamble::Workflow => format!("{PORTABLE_WORKFLOW_BOUNDARY}\n\n{body}"),
            Preamble::SelfContained => body,
        }
    }
}

/// If `text` starts with a virtual skill invocation — `/cadencr:<name>`,
/// `$cadencr:<name>`, or a bare `cadencr:<name>` — expand it into that skill's
/// full prompt body (substituting any trailing arguments for `$ARGUMENTS`).
/// Otherwise return the text unchanged.
///
/// Deliberately strict: it only matches the explicit `cadencr:` namespace on the
/// FIRST token, so it can never hijack a normal message like "review this diff".
pub fn expand_prompt(text: &str) -> Cow<'_, str> {
    let trimmed = text.trim_start();
    let token_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let (token, rest) = trimmed.split_at(token_end);
    let bare = token
        .strip_prefix('/')
        .or_else(|| token.strip_prefix('$'))
        .unwrap_or(token);
    let Some(name) = bare.strip_prefix(ORCHESTRATION_SKILL_PREFIX) else {
        return Cow::Borrowed(text);
    };
    match ORCHESTRATION_SKILLS.iter().find(|skill| skill.name == name) {
        Some(skill) => Cow::Owned(skill.expand(rest)),
        None => Cow::Borrowed(text),
    }
}

/// The complete, declarative catalog. Add a skill by adding an entry and its
/// prompt file under `prompts/` — nothing provider-specific belongs here.
pub const ORCHESTRATION_SKILLS: &[OrchestrationSkill] = &[
    OrchestrationSkill {
        name: "review",
        description: "Spawn an independent reviewer session on this worktree",
        details: "Starts a separate, read-only reviewer session that reads the diff itself and \
                  reports prioritized findings (severity, file:line, problem, fix). Its report \
                  comes back into this conversation, and nothing is changed until you decide \
                  what to do with it. A different model than this one gives the most \
                  independent review.",
        argument_hint: Some("unstaged (default) or branch"),
        parameters: SPAWN_PARAMETERS,
        body: include_str!("prompts/review.md"),
        preamble: Preamble::FollowedWorkflow,
    },
    OrchestrationSkill {
        name: "rescue",
        description: "Hand this stuck conversation to a fresh model for an unblock suggestion",
        details: "Summarizes where this conversation is stuck and hands that summary to a fresh \
                  session, ideally on another provider or model. It diagnoses the blocker and \
                  proposes one concrete next step plus an alternative, which come back here for \
                  you to accept or redirect.",
        argument_hint: Some("Optional hint about where to focus"),
        parameters: SPAWN_PARAMETERS,
        body: include_str!("prompts/rescue.md"),
        preamble: Preamble::FollowedWorkflow,
    },
    OrchestrationSkill {
        name: "status",
        description: "Render the live tree of spawned Cadencr sessions and any blocked gates",
        details: "Reads the session graph and renders the sessions related to this one with \
                  their live status, flagging any that wait on a gate. Strictly read-only.",
        argument_hint: Some("Optional session id or title to focus on"),
        parameters: SkillParameters::NONE,
        body: include_str!("prompts/status.md"),
        preamble: Preamble::Workflow,
    },
    OrchestrationSkill {
        name: "parallelize",
        description: "Fan out independent sub-tasks into isolated Cadencr worktrees",
        details: "Splits the work into independent sub-tasks and spawns one session per \
                  sub-task, each in its own new worktree so their edits cannot collide. It \
                  tracks which ones have replied and asks what to do with the results once \
                  all are back. The configuration below applies to every spawned session.",
        argument_hint: Some("The independent sub-tasks, e.g. backend tests; frontend tests"),
        parameters: SkillParameters {
            agent: true,
            worktrees: &[SkillWorktree::New],
        },
        body: include_str!("prompts/parallelize.md"),
        preamble: Preamble::FollowedWorkflow,
    },
    OrchestrationSkill {
        name: "handoff",
        description: "Transfer this work to a successor session with a self-contained brief",
        details: "Writes a self-contained brief (goal, decisions, worktree state, next step) and \
                  hands the work to a successor session, recorded as a handoff in the session \
                  graph. Keep the same worktree to continue on the exact same changes, \
                  uncommitted ones included.",
        argument_hint: Some("Who to hand off to, or why"),
        parameters: SPAWN_PARAMETERS,
        body: include_str!("prompts/handoff.md"),
        preamble: Preamble::FollowedWorkflow,
    },
    OrchestrationSkill {
        name: "visualize",
        description: "Draw a chart or an interactive HTML visual inline in the conversation",
        details: "Draws a chart, diagram or interactive HTML visual from real data, rendered \
                  inline in this conversation.",
        argument_hint: Some("What to visualize"),
        parameters: SkillParameters::NONE,
        body: include_str!("prompts/visualize.md"),
        preamble: Preamble::SelfContained,
    },
];

/// Parameters of a skill that spawns one helper session next to this one.
const SPAWN_PARAMETERS: SkillParameters = SkillParameters {
    agent: true,
    worktrees: &[
        SkillWorktree::Same,
        SkillWorktree::New,
        SkillWorktree::Project,
    ],
};

#[cfg(test)]
mod tests {
    use super::{expand_prompt, ORCHESTRATION_SKILLS, PORTABLE_WORKFLOW_BOUNDARY};

    fn skill_body(name: &str) -> &'static str {
        ORCHESTRATION_SKILLS
            .iter()
            .find(|skill| skill.name == name)
            .unwrap()
            .body
    }

    #[test]
    fn expand_prompt_expands_namespaced_invocation_across_prefixes() {
        // With no arguments the `$ARGUMENTS` placeholder collapses to empty.
        let expected = format!(
            "{PORTABLE_WORKFLOW_BOUNDARY}\n\n{}",
            skill_body("status").replace("$ARGUMENTS", "")
        );
        for token in ["cadencr:status", "/cadencr:status", "$cadencr:status"] {
            let expanded = expand_prompt(token);
            assert_eq!(expanded, expected, "prefix {token}");
            assert!(expanded.starts_with("## CadencR workflow boundary"));
            assert!(expanded.contains("This virtual skill is self-contained"));
            assert!(expanded.contains("Do not search the filesystem for CadencR's installation"));
            assert!(expanded.contains("Inter-agent messages steer an active target turn"));
            assert!(expanded.contains("Do **not** poll"));
            assert!(!expanded.contains("## Child completion ownership"));
        }
    }

    #[test]
    fn expand_prompt_substitutes_trailing_arguments() {
        for (name, arguments) in [
            ("review", "branch"),
            ("parallelize", "backend tests; frontend tests"),
            ("handoff", "continue with a different model"),
        ] {
            let invocation = format!("/cadencr:{name} {arguments}");
            let expanded = expand_prompt(&invocation);
            assert!(expanded.contains(arguments), "skill {name}");
            assert!(!expanded.contains("$ARGUMENTS"), "skill {name}");
        }
    }

    #[test]
    fn handoff_requires_spawn_before_explicit_handoff_link() {
        let expanded = expand_prompt("/cadencr:handoff use another model");
        let spawn = expanded
            .find("first call `project_spawn_session`")
            .expect("spawn instruction");
        let link = expanded
            .find("call `project_link_sessions`")
            .expect("handoff link instruction");

        assert!(spawn < link);
        assert!(expanded.contains("not successful until both"));
    }

    #[test]
    fn followed_skills_get_the_shared_child_completion_boundary() {
        for name in ["review", "rescue", "parallelize", "handoff"] {
            let invocation = format!("/cadencr:{name}");
            let expanded = expand_prompt(&invocation);
            assert!(expanded.contains("## Child completion ownership"));
            assert!(
                expanded.contains("visible to the user in this conversation"),
                "{name} must recognize that the child reply is already visible"
            );
            assert!(expanded.contains(
                "Do not repeat, paraphrase, reformat, summarize, or quote the child's final"
            ));
        }

        let review = expand_prompt("/cadencr:review");
        assert!(review.contains("ask the user what they want to do"));
        assert!(review.contains("with the review"));
    }

    #[test]
    fn visualize_expands_to_self_contained_guidance() {
        let expanded = expand_prompt("/cadencr:visualize weekly build times");
        assert!(expanded.contains("weekly build times"));
        assert!(expanded.contains("```vega-lite"));
        assert!(expanded.contains("```cadencr-html"));
        // No orchestration preamble: drawing needs no MCP tool.
        assert!(!expanded.contains("## CadencR workflow boundary"));
        assert!(!expanded.contains("$ARGUMENTS"));
    }

    #[test]
    fn expand_prompt_applies_the_wizard_configuration() {
        let expanded =
            expand_prompt("/cadencr:review --provider=codex --model=gpt-5 --worktree=new branch");
        assert!(expanded.contains("**Scope argument:** `branch`"));
        assert!(!expanded.contains("--model="));
        let section = expanded
            .find("## Session configuration chosen by the user")
            .expect("configuration section");
        assert!(section > expanded.find("Follow these steps exactly").unwrap());
        assert!(expanded.contains("- `provider`: `codex`"));
        assert!(expanded.contains("- `model`: `gpt-5`"));
        assert!(expanded.contains("\"mode\": \"new_worktree\""));

        // Without flags nothing is appended.
        assert!(!expand_prompt("/cadencr:review").contains("Session configuration"));
        // A skill without parameters keeps flag-looking text as its argument.
        let status = expand_prompt("/cadencr:status --model=opus");
        assert!(status.contains("--model=opus"));
        assert!(!status.contains("Session configuration"));
    }

    #[test]
    fn spawning_skills_declare_parameters_and_details() {
        for skill in ORCHESTRATION_SKILLS {
            assert!(!skill.details.is_empty(), "{} missing details", skill.name);
            let spawns = skill.body.contains("project_spawn_session");
            assert_eq!(skill.parameters.agent, spawns, "{}", skill.name);
            assert_eq!(skill.parameters.is_empty(), !spawns, "{}", skill.name);
        }
    }

    #[test]
    fn expand_prompt_never_hijacks_a_plain_message() {
        // Bare words that merely resemble a skill name must pass through.
        for text in [
            "review this diff please",
            "status update for the team",
            "cadencr is great",
            "please run cadencr:status later",
            "",
        ] {
            assert_eq!(expand_prompt(text), text, "text {text:?}");
        }
    }

    #[test]
    fn expand_prompt_ignores_unknown_skill_name() {
        assert_eq!(expand_prompt("/cadencr:nope"), "/cadencr:nope");
    }

    #[test]
    fn catalog_has_expected_skills_with_bodies() {
        let names: Vec<&str> = ORCHESTRATION_SKILLS.iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec![
                "review",
                "rescue",
                "status",
                "parallelize",
                "handoff",
                "visualize"
            ]
        );
        for skill in ORCHESTRATION_SKILLS {
            assert!(
                !skill.description.is_empty(),
                "{} missing description",
                skill.name
            );
            assert!(
                skill.body.len() > 100,
                "{} body looks empty/stub",
                skill.name
            );
        }
    }

    #[test]
    fn catalog_names_are_unique_and_command_safe() {
        let mut seen = std::collections::HashSet::new();
        for skill in ORCHESTRATION_SKILLS {
            assert!(
                seen.insert(skill.name),
                "duplicate skill name {}",
                skill.name
            );
            assert!(
                skill
                    .name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '-'),
                "{} is not a safe command/file name",
                skill.name
            );
        }
    }
}
