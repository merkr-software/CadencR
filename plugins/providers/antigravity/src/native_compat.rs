//! Native fallback data used before agy publishes its ACP command catalog.
//! Recheck these values and the child-journal fixtures against a new CLI release.

pub(crate) const VERIFIED_CLI_VERSION: &str = "1.5.14";

/// Steering is an agy extension introduced in 1.5.0. ACP v1 alone does not
/// guarantee it. Requalify concurrent prompts before enabling a new CLI major.
pub(crate) fn supports_prompt_steering(version: &str) -> bool {
    semver::Version::parse(version)
        .is_ok_and(|v| v.major == 1 && v >= semver::Version::new(1, 5, 0))
}

pub(crate) fn warn_journal(issue: &str) {
    eprintln!(
        "Antigravity child activity unavailable: {issue}. Check `agy --version` and the CLI's app data directory. The native child journal format was verified with agy {VERIFIED_CLI_VERSION}."
    );
}

pub(crate) const PROMPT_COMMANDS: &[(&str, &str)] = &[
    (
        "goal",
        "Run until the specified goal is completely finished.",
    ),
    (
        "compact",
        "Compact the conversation now (summarize history to free up the context window).",
    ),
    (
        "schedule",
        "Run an instruction on a recurring schedule or as a one-time timer.",
    ),
    ("browser", "Invoke a browser agent for web tasks."),
    ("plan", "Plan carefully before executing a task."),
    ("grill-me", "Interview me to align on a plan."),
    (
        "teamwork",
        "Invoke a team of agents to autonomously tackle large projects.",
    ),
    (
        "learn",
        "Reflect on recent successes or corrections to capture reusable skills or rules.",
    ),
    (
        "boost",
        "Invoke the Boost multi-agent orchestrator for complex tasks.",
    ),
];
// Other bundled skills belong to separate Google products.
pub(crate) const BUNDLED_SKILLS: &[&str] = &[
    "agy-customizations",
    "antigravity_guide",
    "run-workflow",
    "native_swarm",
];
