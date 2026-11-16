//! Live conversations of a project whose folder moves.
//!
//! A conversation keeps the folder it runs in on its handle, and an idle
//! runtime keeps its process (and the provider's own idea of the folder)
//! between turns. While the folder moves, the project's conversations must
//! neither run nor spawn; afterwards they must spawn in the new place. So the
//! move keeps new runtime cells from binding (`registry::launch_fence`),
//! holds every existing cell's launch claim, closes the idle runtimes (their
//! next prompt resumes them), and finally points the handles at the new
//! folder before letting them spawn and bind again.

use std::collections::HashSet;
use std::path::Path;

use tokio::sync::OwnedMutexGuard;

use super::detached_runtime::{resume_session_id, DetachedRuntime};
use super::prompt::prompt_runtime_config::reset_handle_to_pending;
use super::prompt::respawn_deferral::respawn_deferral;
use super::registry::LaunchFence;
use super::{QueryState, SdkHandle, SdkSessions};
use crate::app_state::AppState;
use crate::shared::path_rebase::rebase;

type Claim = (i64, SdkSessions, OwnedMutexGuard<()>);

const BUSY: &str = "A conversation of this project is still working (a turn, a question, or a \
                    background task); wait for it to finish or stop it, then try again";

/// The project's conversations, kept from binding and spawning until released.
#[must_use = "dropping the hold lets the conversations spawn in the old folder"]
pub(crate) struct RelocationHold {
    claims: Vec<Claim>,
    fence: LaunchFence,
}

/// Hold every conversation of `feature_ids` and close the runtimes that sit
/// idle. Refused, before any runtime closes, when one of them still owes the
/// agent work.
pub(crate) async fn hold_for_relocation(
    app_state: &AppState,
    feature_ids: &HashSet<i64>,
) -> Result<RelocationHold, String> {
    let (fence, claims) = app_state
        .session_runtimes
        .claim_feature_launches(feature_ids)
        .await;
    for (session_id, cell, _claim) in &claims {
        let handles = app_state
            .session_runtimes
            .lock_settled(cell, *session_id)
            .await;
        if handles
            .get(session_id)
            .is_some_and(|handle| is_busy(app_state, *session_id, handle))
        {
            return Err(BUSY.into());
        }
    }
    let retired = retire_idle(app_state, &claims).await?;
    futures::future::join_all(
        retired
            .into_iter()
            .map(|runtime| runtime.close_in(app_state)),
    )
    .await;
    Ok(RelocationHold { claims, fence })
}

fn is_busy(app_state: &AppState, session_id: i64, handle: &SdkHandle) -> bool {
    match &handle.state {
        QueryState::Active { query, .. } => {
            respawn_deferral(app_state, session_id, query).is_some()
        }
        _ => false,
    }
}

/// Detach the idle runtimes; their next prompt resumes them. A turn that
/// started since the check above still refuses the move.
async fn retire_idle(
    app_state: &AppState,
    claims: &[Claim],
) -> Result<Vec<DetachedRuntime>, String> {
    let mut retired = Vec::new();
    for (session_id, cell, _claim) in claims {
        let mut handles = app_state
            .session_runtimes
            .lock_settled(cell, *session_id)
            .await;
        let Some(handle) = handles.get_mut(session_id) else {
            continue;
        };
        let QueryState::Active { query, .. } = &handle.state else {
            continue;
        };
        let query = query.clone();
        if respawn_deferral(app_state, *session_id, &query).is_some() {
            drop(handles);
            futures::future::join_all(
                retired
                    .into_iter()
                    .map(|runtime: DetachedRuntime| runtime.close_in(app_state)),
            )
            .await;
            return Err(BUSY.into());
        }
        let resume_id = resume_session_id(&query, &handle.runtime_provider).await;
        reset_handle_to_pending(handle, resume_id);
        retired.push(DetachedRuntime::of(
            handle,
            query,
            *session_id,
            &app_state.session_runtimes,
        ));
    }
    Ok(retired)
}

impl RelocationHold {
    /// Point the held conversations at `to` instead of any spelling of the
    /// old folder in `from`, then let them spawn and bind again.
    pub(crate) async fn release_into(self, from: &[&Path], to: &Path) {
        let Self { claims, fence } = self;
        for (session_id, cell, claim) in claims {
            if let Some(handle) = cell.lock().await.get_mut(&session_id) {
                rebase_handle(handle, from, to);
            }
            drop(claim);
        }
        drop(fence);
    }
}

fn rebase_handle(handle: &mut SdkHandle, from: &[&Path], to: &Path) {
    let Some(cwd) = from
        .iter()
        .find_map(|from| rebase(&handle.config.cwd, from, to))
    else {
        return;
    };
    handle.config.canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
    if let QueryState::Pending(options) = &mut handle.state {
        options.cwd = cwd.clone();
    }
    handle.config.cwd = cwd;
}
