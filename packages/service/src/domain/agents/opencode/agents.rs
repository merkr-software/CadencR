use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use opencode_sdk_rs::OpenCodeGeneration;

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::agents::runtime::ProviderModeCatalogEntry;
use crate::shared::cli_stderr;

const AGENT_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_LIST_CACHE_TTL: Duration = Duration::from_secs(30);
const MODE_PREFIX: &str = "opencodeAgent:";
const BUILTIN_PRIMARY_AGENTS: &[&str] = &["build", "plan", "summary", "title", "compaction"];

#[derive(Clone)]
struct CachedAgentModes {
    modes: Vec<ProviderModeCatalogEntry>,
    fetched_at: Instant,
}

static AGENT_MODE_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedAgentModes>>> = OnceLock::new();

pub(crate) fn mode_id_for_agent(name: &str) -> String {
    format!("{MODE_PREFIX}{name}")
}

pub(crate) fn agent_name_from_mode_id(mode: &str) -> Option<&str> {
    mode.strip_prefix(MODE_PREFIX)
        .filter(|name| !name.is_empty())
}

pub(in crate::domain::agents::opencode) async fn primary_agent_modes(
    cwd: &Path,
) -> Vec<ProviderModeCatalogEntry> {
    let cache_key = cwd.to_path_buf();
    if let Some(modes) = cached_modes(&cache_key).await {
        return modes;
    }

    let listed = list_agents_output(cwd)
        .await
        .and_then(|(generation, output)| match generation {
            OpenCodeGeneration::V1 => Ok(parse_primary_agent_modes(&output)),
            OpenCodeGeneration::V2 => parse_v2_primary_agent_modes(&output),
        });
    match listed {
        Ok(modes) => {
            cache_modes(cache_key, modes.clone()).await;
            modes
        }
        Err(error) => {
            tracing::warn!(%error, cwd = %cwd.display(), "failed to list OpenCode agents");
            Vec::new()
        }
    }
}

async fn cached_modes(cwd: &Path) -> Option<Vec<ProviderModeCatalogEntry>> {
    let cache = AGENT_MODE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cache = cache.lock().await;
    let cached = cache.get(cwd)?;
    (cached.fetched_at.elapsed() < AGENT_LIST_CACHE_TTL).then(|| cached.modes.clone())
}

async fn cache_modes(cwd: PathBuf, modes: Vec<ProviderModeCatalogEntry>) {
    let cache = AGENT_MODE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    cache.lock().await.insert(
        cwd,
        CachedAgentModes {
            modes,
            fetched_at: Instant::now(),
        },
    );
}

/// The agent listing of the resolved CLI: `opencode agent list` (text) on
/// 1.x, `opencode debug agents` (JSON) on 2.x.
async fn list_agents_output(cwd: &Path) -> Result<(OpenCodeGeneration, String), RuntimeError> {
    let installation = opencode_sdk_rs::resolve_installation().await?;
    // `--standalone`: without it 2.x starts its background service and
    // leaves it running.
    let args: &[&str] = match installation.generation {
        OpenCodeGeneration::V1 => &["agent", "list"],
        OpenCodeGeneration::V2 => &["debug", "agents", "--standalone"],
    };
    // Captured through a file: OpenCode cuts a piped stdout at 64 KiB, and
    // the 2.x JSON carries every agent's prompt.
    let run = opencode_sdk_rs::capture_opencode_command(
        &installation.path,
        Some(cwd),
        args,
        AGENT_LIST_TIMEOUT,
    )
    .await?;
    if !run.status.success() {
        return Err(agent_list_failure(&run.label, &run.status, &run.stderr));
    }
    Ok((installation.generation, run.stdout))
}

/// Why the agent listing failed, from the end of its stderr (bounded, known
/// secrets masked).
fn agent_list_failure(
    label: &str,
    status: &std::process::ExitStatus,
    stderr: &str,
) -> RuntimeError {
    RuntimeError::new(cli_stderr::command_failure(
        label,
        status,
        stderr,
        &cli_stderr::secret_values([]),
    ))
}

fn parse_primary_agent_modes(raw: &str) -> Vec<ProviderModeCatalogEntry> {
    modes_from(raw.lines().map(str::trim).filter_map(parse_agent_header))
}

/// `opencode debug agents` (2.x): a JSON array of `{id, mode, hidden, …}`.
fn parse_v2_primary_agent_modes(raw: &str) -> Result<Vec<ProviderModeCatalogEntry>, RuntimeError> {
    let agents = serde_json::from_str::<Vec<serde_json::Value>>(raw).map_err(|error| {
        RuntimeError::new(format!(
            "opencode debug agents returned unexpected output: {error}"
        ))
    })?;
    Ok(modes_from(
        agents
            .iter()
            .filter(|agent| agent.get("hidden").and_then(serde_json::Value::as_bool) != Some(true))
            .filter_map(|agent| {
                Some((
                    agent.get("id").and_then(serde_json::Value::as_str)?,
                    agent.get("mode").and_then(serde_json::Value::as_str)?,
                ))
            }),
    ))
}

/// The Shift+Tab modes for `(name, mode)` agents: user-invokable custom
/// agents, once each.
fn modes_from<'a>(
    agents: impl Iterator<Item = (&'a str, &'a str)>,
) -> Vec<ProviderModeCatalogEntry> {
    let mut seen = HashSet::new();
    agents
        .filter(|(name, mode)| {
            is_user_invokable_mode(mode)
                && !BUILTIN_PRIMARY_AGENTS.contains(name)
                && !name.contains('/')
                && seen.insert(*name)
        })
        .map(|(name, _)| ProviderModeCatalogEntry {
            id: mode_id_for_agent(name),
            label: name.to_string(),
            description: Some(format!("Use the OpenCode {name} agent.")),
            accent: None,
        })
        .collect()
}

/// OpenCode agents declare themselves as `primary` (user-invokable),
/// `subagent` (only callable by other agents), or `all` (both). The Shift+Tab
/// cycle should expose anything the user can invoke directly, so accept both
/// `primary` and `all`.
fn is_user_invokable_mode(mode: &str) -> bool {
    matches!(mode, "primary" | "all")
}

fn parse_agent_header(line: &str) -> Option<(&str, &str)> {
    let (name, suffix) = line.rsplit_once(" (")?;
    let mode = suffix.strip_suffix(')')?;
    if name.is_empty() || mode.is_empty() {
        return None;
    }
    Some((name, mode))
}

#[cfg(test)]
mod tests {
    use super::{
        agent_list_failure, agent_name_from_mode_id, parse_primary_agent_modes,
        parse_v2_primary_agent_modes,
    };

    #[test]
    fn v2_debug_agents_lists_visible_custom_primary_agents() {
        let modes = parse_v2_primary_agent_modes(
            r#"[
                {"id":"build","mode":"primary","hidden":false},
                {"id":"plan","mode":"primary","hidden":false},
                {"id":"compaction","mode":"primary","hidden":true},
                {"id":"general","mode":"subagent","hidden":false},
                {"id":"reviewer","mode":"all","hidden":false},
                {"id":"secret","mode":"primary","hidden":true}
            ]"#,
        )
        .unwrap();
        let ids: Vec<_> = modes.iter().map(|mode| mode.label.as_str()).collect();
        assert_eq!(ids, vec!["reviewer"]);
        assert!(parse_v2_primary_agent_modes("not json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_agent_list_says_why_without_raw_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let secret = "sk-simulated-opencode-secret";
        let _lock = crate::shared::test_env::env_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _token =
            crate::shared::test_env::EnvVarGuard::set("CADENCR_TEST_OPENCODE_AGENTS_TOKEN", secret);
        let stderr = format!(
            "{}\n\u{1b}[31mError:\u{1b}[0m token {secret} rejected\n",
            "noise ".repeat(200)
        );
        let error = agent_list_failure(
            "opencode agent list",
            &std::process::ExitStatus::from_raw(1 << 8),
            &stderr,
        );
        assert_eq!(
            error.to_string(),
            "opencode agent list exited with status 1: Error: token ••• rejected"
        );
    }

    #[test]
    fn parses_custom_primary_agents_from_cli_output() {
        let modes = parse_primary_agent_modes(
            r#"build (primary)
  [{"permission":"*"}]
documentor (primary)
  []
scenario-builder (primary)
  []
explore (subagent)
  []
scenario-builder/SCENARIO_TEMPLATE (all)
  []
"#,
        );

        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0].id, "opencodeAgent:documentor");
        assert_eq!(modes[0].label, "documentor");
        assert_eq!(modes[1].id, "opencodeAgent:scenario-builder");
    }

    #[test]
    fn includes_custom_all_mode_agents() {
        // Custom agents declared with `mode: all` should also surface in the
        // Shift+Tab cycle — `all` just means the agent can be invoked both
        // directly and as a sub-agent.
        let modes = parse_primary_agent_modes(
            r#"build (primary)
  []
researcher (all)
  []
explore (subagent)
  []
"#,
        );

        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].id, "opencodeAgent:researcher");
        assert_eq!(modes[0].label, "researcher");
    }

    #[test]
    fn excludes_subagents_and_nested_templates() {
        let modes = parse_primary_agent_modes(
            r#"explore (subagent)
  []
scenario-builder/SCENARIO_TEMPLATE (all)
  []
"#,
        );

        assert!(modes.is_empty());
    }

    #[test]
    fn parses_agent_name_from_mode_id() {
        assert_eq!(
            agent_name_from_mode_id("opencodeAgent:documentor"),
            Some("documentor")
        );
        assert_eq!(agent_name_from_mode_id("opencodeAgent:"), None);
        assert_eq!(agent_name_from_mode_id("plan"), None);
    }
}
