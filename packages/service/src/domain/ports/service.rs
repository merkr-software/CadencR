use std::collections::HashMap;

use crate::app_state::AppState;
use crate::domain::terminal::activity::live_shell_pids_by_feature;
use crate::error::AppError;

use super::attribution::{attribute, resolve, unresolved_pids, ProcessRoots};
use super::models::{FeaturePorts, PortSource};
use super::provider_processes::ProviderProcessScan;
use super::repository;
use super::scan;

/// Ports currently held by every feature's own processes.
pub async fn feature_ports(state: &AppState) -> Result<Vec<FeaturePorts>, AppError> {
    state.port_scan.get_or_refresh(|| scan_now(state)).await
}

async fn scan_now(state: &AppState) -> Result<Vec<FeaturePorts>, AppError> {
    let service_pid = std::process::id() as i32;
    let provider_processes = ProviderProcessScan::begin();
    let sockets = scan::listening_sockets()
        .await
        .map_err(|error| scan_error("Failed to inspect listening processes", error))?;
    if sockets.is_empty() {
        return Ok(Vec::new());
    }

    // Read parents after lsof so processes that started during its scan are
    // visible to attribution too.
    let parents = scan::parent_map()
        .await
        .map_err(|error| scan_error("Failed to inspect listening processes", error))?;
    let provider_processes = provider_processes.finish();
    let roots = process_roots(state).await;
    let resolved = resolve(&sockets, &parents, &roots, &provider_processes, service_pid);

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

/// Stable code of a scan that timed out; the scan cache backs off from it.
pub(super) const PORT_SCAN_TIMEOUT: &str = "PORT_SCAN_TIMEOUT";
/// Stable code of a scan whose tool is not installed.
pub(super) const PORT_SCAN_TOOL_MISSING: &str = "PORT_SCAN_TOOL_MISSING";

/// A missing `lsof` is an install problem the user can fix, so it gets a
/// stable code and an actionable message; a timeout gets its own retryable
/// code; anything else stays internal.
#[track_caller]
fn scan_error(context: &str, error: anyhow::Error) -> AppError {
    if let Some(timeout) = error.downcast_ref::<scan::ScanTimeout>() {
        return AppError::coded(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            PORT_SCAN_TIMEOUT,
            format!("{context}: {timeout}. Ports will be checked again shortly."),
        );
    }
    match error.downcast_ref::<scan::MissingTool>() {
        Some(missing) => AppError::coded(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            PORT_SCAN_TOOL_MISSING,
            format!(
                "{missing}. Install `{}` with your package manager (for example \
                 `sudo apt install {0}`, `sudo dnf install {0}` or `sudo pacman -S {0}`) \
                 to see the servers your features are running.",
                missing.program
            ),
        ),
        None => AppError::internal(format!("{context}: {error}")),
    }
}

/// Every pid that names a feature outright. Terminals are registered last so a
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
    fn a_scan_timeout_maps_to_a_retryable_coded_error() {
        let error = anyhow::Error::from(scan::ScanTimeout {
            program: "lsof".into(),
        });
        match scan_error("ctx", error) {
            AppError::Coded { status, code, .. } => {
                assert_eq!(code, PORT_SCAN_TIMEOUT);
                assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
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
