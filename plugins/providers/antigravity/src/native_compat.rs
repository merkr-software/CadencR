//! Native fallback data used before agy publishes its ACP command catalog.
//! Recheck these values and the child-journal fixtures against a new CLI release.

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
