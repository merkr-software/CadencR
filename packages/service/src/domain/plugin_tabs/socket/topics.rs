//! The stream topics a plugin socket can subscribe to (§4.4), each fed by the
//! service's existing broadcaster and bound to the grant's feature/project.

use std::collections::HashMap;

use futures::FutureExt;
use serde_json::json;
use tokio::sync::{broadcast, mpsc};

use super::emitter::{Emitter, Frame};
use super::session_stream::{self, forward};
use super::subscriptions::{Cleanup, Started};
use crate::app_state::AppState;
use crate::domain::editor::watcher::FileWatcher;
use crate::domain::feature_events::FeatureEvent;
use crate::domain::git::forge::PrStatusSnapshot;
use crate::domain::plugin_tabs::grants::Grant;
use crate::domain::plugin_tabs::policy::Scope;
use crate::domain::session_status::SessionStatusEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Topic {
    GitStatus,
    SessionStream,
    FilesChanges,
    ForgeStatus,
    FeatureEvents,
    SessionStatus,
    BackendEvents,
}

impl Topic {
    pub const ALL: [Topic; 7] = [
        Topic::GitStatus,
        Topic::SessionStream,
        Topic::FilesChanges,
        Topic::ForgeStatus,
        Topic::FeatureEvents,
        Topic::SessionStatus,
        Topic::BackendEvents,
    ];

    pub fn parse(name: &str) -> Option<Topic> {
        Topic::ALL.into_iter().find(|topic| topic.name() == name)
    }

    pub const fn name(self) -> &'static str {
        match self {
            Topic::GitStatus => "git.status",
            Topic::SessionStream => "session.stream",
            Topic::FilesChanges => "files.changes",
            Topic::ForgeStatus => "forge.status",
            Topic::FeatureEvents => "feature.events",
            Topic::SessionStatus => "session.status",
            Topic::BackendEvents => "backend.events",
        }
    }

    pub const fn scope(self) -> Option<Scope> {
        Some(match self {
            Topic::GitStatus => Scope::GitRead,
            Topic::SessionStream => Scope::AgentObserve,
            Topic::FilesChanges => Scope::FilesRead,
            Topic::ForgeStatus => Scope::ForgeRead,
            Topic::FeatureEvents => Scope::FeaturesRead,
            Topic::SessionStatus => Scope::WorkspaceRead,
            Topic::BackendEvents => return None,
        })
    }
}

type StartError = (&'static str, String);

/// Register the source of `topic` for the grant; the forwarder runs once the
/// caller spawns it.
pub async fn start(
    topic: Topic,
    state: &AppState,
    grant: &Grant,
    emitter: Emitter,
    backend_topic: String,
) -> Result<Started, StartError> {
    match topic {
        Topic::GitStatus => git_status(state, grant.feature_id, emitter).await,
        Topic::SessionStream => Ok(session_stream::start(state, grant.feature_id, emitter)),
        Topic::FilesChanges => files_changes(state, grant, emitter).await,
        // Broadcast receivers are created here, before `subscribed` is
        // replied, so no event after the reply can be missed.
        Topic::ForgeStatus => {
            let rx = state.forge_events_tx.subscribe();
            Ok(detached(forge_status(
                state.clone(),
                rx,
                grant.feature_id,
                emitter,
            )))
        }
        Topic::FeatureEvents => {
            let rx = state.feature_events_tx.subscribe();
            Ok(detached(feature_events(
                state.clone(),
                rx,
                grant.project_id,
                emitter,
            )))
        }
        Topic::SessionStatus => {
            let rx = state.session_status_tx.subscribe();
            Ok(detached(session_status(state.clone(), rx, emitter)))
        }
        Topic::BackendEvents => super::backend::start(state, grant, backend_topic, emitter)
            .await
            .map_err(super::backend::problem),
    }
}

fn detached(future: impl std::future::Future<Output = ()> + Send + 'static) -> Started {
    Started {
        run: future.boxed(),
        cleanup: Cleanup::None,
    }
}

async fn git_status(
    state: &AppState,
    feature_id: i64,
    emitter: Emitter,
) -> Result<Started, StartError> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let snapshot = match state
        .git_watcher
        .subscribe(state, feature_id, tx.clone())
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            state.git_watcher.unsubscribe_sender(&tx).await;
            return Err(("WATCHER_ERROR", error.to_string()));
        }
    };
    let run = async move {
        if !emitter.emit("git", "status", &snapshot) {
            return;
        }
        let keep = |frame: &Frame<'_>| {
            frame.domain == "git" && matches!(&*frame.action, "status" | "status_error")
        };
        while let Some(message) = rx.recv().await {
            if !forward(&message, &emitter, keep) {
                return;
            }
        }
    };
    Ok(Started {
        run: run.boxed(),
        cleanup: Cleanup::GitWatcher(tx),
    })
}

/// A dedicated watcher of the feature's worktree: the shared editor watcher
/// follows the renderer's current project, which a hidden tab must not steal.
/// Starting it walks the tree for `.gitignore`s, so it runs off the runtime.
async fn files_changes(
    state: &AppState,
    grant: &Grant,
    emitter: Emitter,
) -> Result<Started, StartError> {
    let root = crate::domain::projects::service::resolve_feature_editor_root(
        &state.read_pool,
        grant.project_id,
        Some(grant.feature_id),
    )
    .await
    .map_err(|error| ("BAD_REQUEST", error.to_string()))?;
    let (tx, mut rx) = broadcast::channel(16);
    let runtime = tokio::runtime::Handle::current();
    let feature_id = grant.feature_id;
    let watcher = tokio::task::spawn_blocking(move || {
        let _runtime = runtime.enter();
        let mut watcher = FileWatcher::new();
        watcher
            .start(&root.to_string_lossy(), Some(feature_id), tx)
            .map(|()| WatcherGuard(watcher))
    })
    .await
    .map_err(|error| ("WATCHER_ERROR", error.to_string()))?
    .map_err(|error| ("WATCHER_ERROR", error))?;
    let run = async move {
        let _watcher = watcher;
        loop {
            let open = match rx.recv().await {
                Ok(event) => emitter.emit(
                    "editor",
                    "file_tree.changed",
                    &json!({ "project_path": event.project_path }),
                ),
                Err(broadcast::error::RecvError::Lagged(_)) => emitter.resync(),
                Err(broadcast::error::RecvError::Closed) => false,
            };
            if !open {
                break;
            }
        }
    };
    Ok(detached(run))
}

/// Stops the dedicated watcher when its subscription task ends or is aborted.
struct WatcherGuard(FileWatcher);

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        self.0.stop();
    }
}

async fn forge_status(
    state: AppState,
    mut rx: broadcast::Receiver<PrStatusSnapshot>,
    feature_id: i64,
    emitter: Emitter,
) {
    let snapshot = |status: Option<PrStatusSnapshot>| {
        status.is_none_or(|status| emitter.emit("git", "pr_status", &status))
    };
    if !snapshot(state.forge_status.get(feature_id).await) {
        return;
    }
    loop {
        let open = match rx.recv().await {
            Ok(status) if status.feature_id == feature_id => {
                emitter.emit("git", "pr_status", &status)
            }
            Ok(_) => true,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                snapshot(state.forge_status.get(feature_id).await)
            }
            Err(broadcast::error::RecvError::Closed) => false,
        };
        if !open {
            return;
        }
    }
}

async fn feature_events(
    state: AppState,
    mut rx: broadcast::Receiver<FeatureEvent>,
    project_id: i64,
    emitter: Emitter,
) {
    // A feature never changes project: remember what was looked up.
    let mut owners: HashMap<i64, Option<i64>> = HashMap::new();
    loop {
        let open = match rx.recv().await {
            Ok(event) => match owner(&state, &event, &mut owners).await {
                Ok(owner) if owner == Some(project_id) => {
                    emitter.emit("app", "feature_event", &event)
                }
                Ok(_) => true,
                Err(error) => {
                    tracing::warn!(%error, "cannot attribute a feature event to a project");
                    emitter.resync()
                }
            },
            Err(broadcast::error::RecvError::Lagged(_)) => emitter.resync(),
            Err(broadcast::error::RecvError::Closed) => false,
        };
        if !open {
            return;
        }
    }
}

/// The event's project, looked up when it omits it; `None` for a feature
/// already gone (it cannot be attributed and is not forwarded).
async fn owner(
    state: &AppState,
    event: &FeatureEvent,
    owners: &mut HashMap<i64, Option<i64>>,
) -> Result<Option<i64>, crate::error::AppError> {
    if let Some(project_id) = event.project_id {
        return Ok(Some(project_id));
    }
    if let Some(owner) = owners.get(&event.feature_id) {
        return Ok(*owner);
    }
    let owner = crate::domain::features::repository::project_id_for_feature(
        &state.read_pool,
        event.feature_id,
    )
    .await
    .map(Some)
    .or_else(|error| match error {
        crate::error::AppError::NotFound(_) => Ok(None),
        other => Err(other),
    })?;
    if owner.is_some() {
        owners.insert(event.feature_id, owner);
    }
    Ok(owner)
}

/// `rx` was subscribed before the snapshot is read, so nothing between the
/// two is lost.
async fn session_status(
    state: AppState,
    mut rx: broadcast::Receiver<SessionStatusEvent>,
    emitter: Emitter,
) {
    if !emit_session_status_snapshot(&state, &emitter) {
        return;
    }
    loop {
        let open = match rx.recv().await {
            Ok(event) => emitter.emit("app", "session_status.update", &event),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                emit_session_status_snapshot(&state, &emitter)
            }
            Err(broadcast::error::RecvError::Closed) => false,
        };
        if !open {
            return;
        }
    }
}

/// The same snapshot `/ws` sends, running turns stamped with their start.
fn emit_session_status_snapshot(state: &AppState, emitter: &Emitter) -> bool {
    emitter.emit(
        "app",
        "session_status.snapshot",
        &state.session_status_tx.snapshot(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_round_trip_and_carry_their_scope() {
        for topic in Topic::ALL {
            assert_eq!(Topic::parse(topic.name()), Some(topic));
        }
        assert_eq!(Topic::parse("session.control"), None);
        assert_eq!(Topic::SessionStatus.scope(), Some(Scope::WorkspaceRead));
        assert_eq!(Topic::BackendEvents.scope(), None);
    }
}
