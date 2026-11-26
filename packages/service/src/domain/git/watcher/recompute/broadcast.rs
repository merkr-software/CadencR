//! Deliver status and watcher outcomes to the currently bound feature subscribers.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::warn;

use super::super::handle::{spawn_handle, RegistryInner, WatcherHandle};
use super::super::subscription::{broadcast_envelope, status_error_payload};
use super::generation_changed;
use crate::app_state::AppState;
use crate::domain::git::feature_dir::{is_worktree_unavailable, require_linked_checkout};
use crate::domain::ws_session::protocol::WsEnvelope;
use crate::error::AppError;

pub(super) struct StatusBroadcast<'a> {
    registry: &'a Mutex<RegistryInner>,
    worktree_path: &'a Path,
    expected_write_generation: Option<(Arc<AtomicU64>, u64)>,
    watcher_outcome: Option<Option<String>>,
}

impl<'a> StatusBroadcast<'a> {
    pub(super) fn new(
        registry: &'a Mutex<RegistryInner>,
        worktree_path: &'a Path,
        expected_write_generation: Option<(Arc<AtomicU64>, u64)>,
    ) -> Self {
        Self {
            registry,
            worktree_path,
            expected_write_generation,
            watcher_outcome: None,
        }
    }

    pub(super) async fn rebind(
        &mut self,
        registry: &Arc<Mutex<RegistryInner>>,
        state: &AppState,
        linked_root: Option<&Path>,
    ) -> Option<WatcherHandle> {
        match spawn_handle(
            registry.clone(),
            self.worktree_path.to_path_buf(),
            state.clone(),
        )
        .await
        {
            Ok(replacement) => {
                let mut inner = registry.lock().await;
                if inner
                    .handles
                    .get(self.worktree_path)
                    .is_none_or(|handle| handle.subscribers.is_empty())
                {
                    return None;
                }
                if generation_changed(&self.expected_write_generation) {
                    return None;
                }
                self.expected_write_generation = Some((
                    replacement.write_generation.clone(),
                    replacement.write_generation.load(Ordering::Acquire),
                ));
                self.watcher_outcome = Some(None);
                inner.replace_handle(self.worktree_path, linked_root, replacement)
            }
            Err(error) => {
                warn!(path = %self.worktree_path.display(), %error, "git watcher: rebind failed");
                self.watcher_outcome = Some(Some(error.to_string()));
                None
            }
        }
    }

    pub(super) async fn checkout_git_dir(
        &self,
        linked_root: Option<&Path>,
        features: impl Iterator<Item = i64>,
    ) -> Result<Option<PathBuf>, ()> {
        if let Some(root) = linked_root {
            match require_linked_checkout(self.worktree_path, root).await {
                Ok(git_dir) => return Ok(Some(git_dir)),
                Err(error) => {
                    for fid in features {
                        self.error(fid, &error).await;
                    }
                    return Err(());
                }
            }
        }
        Ok(None)
    }

    pub(super) async fn send(
        &self,
        feature_id: i64,
        action: &str,
        mut payload: serde_json::Value,
        needs_rebind: bool,
    ) {
        // A feature can change checkouts while Git runs. Check the live
        // subscription under the same lock that removes the old checkout.
        let mut inner = self.registry.lock().await;
        if generation_changed(&self.expected_write_generation) {
            return;
        }
        let Some(handle) = inner.handles.get_mut(self.worktree_path) else {
            return;
        };
        handle.needs_rebind |= needs_rebind;
        let senders = handle
            .subscribers
            .iter()
            .filter(|subscriber| subscriber.feature_id == feature_id)
            .map(|subscriber| subscriber.sender.clone())
            .collect::<Vec<_>>();
        if let Some(watcher_error) = &self.watcher_outcome {
            payload["watcher_error"] = serde_json::json!(watcher_error);
        }
        broadcast_envelope(&senders, &WsEnvelope::new("git", action, payload));
    }

    pub(super) async fn error(&self, feature_id: i64, error: &AppError) {
        warn!(
            feature_id,
            path = %self.worktree_path.display(),
            %error,
            "git watcher: compute_status failed"
        );
        self.send(
            feature_id,
            "status_error",
            status_error_payload(feature_id, error),
            is_worktree_unavailable(error),
        )
        .await;
    }
}
