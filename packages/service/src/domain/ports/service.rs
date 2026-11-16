use std::collections::HashMap;

use crate::app_state::AppState;
use crate::domain::terminal::activity::live_shell_pids_by_feature;
use crate::error::AppError;

use super::attribution::{attribute, resolve, unresolved_pids, ProcessRoots};
use super::models::{FeaturePorts, PortSource};
use super::repository;
use super::scan;

/// Ports currently held by every feature's own processes.
pub async fn feature_ports(state: &AppState) -> Result<Vec<FeaturePorts>, AppError> {
    state.port_scan.get_or_refresh(|| scan_now(state)).await
}

async fn scan_now(state: &AppState) -> Result<Vec<FeaturePorts>, AppError> {
    let service_pid = std::process::id() as i32;
    let (sockets, parents) = tokio::try_join!(scan::listening_sockets(), scan::parent_map())
        .map_err(|error| scan_error("Failed to inspect listening processes", error))?;
    if sockets.is_empty() {
        return Ok(Vec::new());
    }

    let roots = process_roots(state).await;
    let resolved = resolve(&sockets, &parents, &roots, service_pid);

    // Only sockets no live terminal or agent explains need a directory, and the
    // worktree list is worth loading only if there is something to match it
    // against — the common case is that ancestry has already answered.
    let pending = unresolved_pids(&resolved);
    if pending.is_empty() {
        return Ok(attribute(resolved, &HashMap::new(), &[]));
    }
    let feature_dirs = repository::unambiguous_worktree_dirs(&state.read_pool).await?;
    if feature_dirs.is_empty() {
        return Ok(attribute(resolved, &HashMap::new(), &[]));
    }
    let cwds = scan::cwd_map(&pending)
        .await
        .map_err(|error| scan_error("Failed to resolve process directories", error))?;

    Ok(attribute(resolved, &cwds, &feature_dirs))
}

/// A missing `lsof`/`ps` is an install problem the user can fix, so it gets a
/// stable code and an actionable message; anything else stays internal.
#[track_caller]
fn scan_error(context: &str, error: anyhow::Error) -> AppError {
    match error.downcast_ref::<scan::MissingTool>() {
        Some(missing) => AppError::Coded {
            status: axum::http::StatusCode::SERVICE_UNAVAILABLE,
            code: "PORT_SCAN_TOOL_MISSING",
            message: format!(
                "{missing}. Install `{}` with your package manager (for example \
                 `sudo apt install {0}`, `sudo dnf install {0}` or `sudo pacman -S {0}`) \
                 to see the servers your features are running.",
                missing.program
            ),
        },
        None => AppError::internal(format!("{context}: {error}")),
    }
}

/// Every pid that names a feature outright. Terminals are registered first so a
/// shell keeps its own feature even when an agent started it — the terminal is
/// the more specific claim.
async fn process_roots(state: &AppState) -> ProcessRoots {
    let mut roots: ProcessRoots = state
        .active_turns
        .agent_process_owners()
        .await
        .into_iter()
        .map(|(pid, feature_id)| (pid, (feature_id, PortSource::Agent)))
        .collect();
    for (pid, feature_id) in live_shell_pids_by_feature(&state.pty_manager) {
        roots.insert(pid, (feature_id, PortSource::Terminal));
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tool_maps_to_an_actionable_coded_error() {
        let error = anyhow::Error::from(scan::MissingTool {
            program: "lsof".into(),
        });
        match scan_error("ctx", error) {
            AppError::Coded { code, message, .. } => {
                assert_eq!(code, "PORT_SCAN_TOOL_MISSING");
                assert!(message.contains("sudo apt install lsof"), "{message}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn other_scan_failures_stay_internal() {
        let error = scan_error("ctx", anyhow::anyhow!("boom"));
        assert!(matches!(error, AppError::Internal(message) if message == "ctx: boom"));
    }
}
