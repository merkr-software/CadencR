//! Access-mode changes. Default <-> Auto Review switch in place; a change
//! into or out of Full Access needs new `agent` launch flags, so the child is
//! replaced and every session restored with `session/load` (same sessionId,
//! cwd, mcpServers), its replay suppressed, then mode and model re-applied.
//!
//! Cursor saves a conversation only once its first prompt runs, so a session
//! fresh from `session/new` cannot be restored yet (`session/load` answers
//! "Session not found" and the conversation would be lost). Cadencr applies
//! the remembered access mode right after `session/new`, so a switch into
//! Full Access before the first prompt is accepted and deferred: until that
//! prompt ends, the connector answers each Cursor permission request with
//! `allow_once` (Cursor's sandbox stays on, so the turn never gets more than
//! the user chose), then restarts `agent` with the Full Access flags before
//! answering the turn. Leaving Full Access cannot be deferred safely and is
//! refused for a fresh session.

use std::sync::Arc;

use serde_json::json;

use super::host_requests::authenticate;
use super::rpc::RpcError;
use super::{invalid_params, Proxy};
use crate::access::AccessMode;

/// What an access-mode change needs, given the proxy state.
#[derive(Debug, PartialEq, Eq)]
enum AccessChange {
    /// No new launch flags: record the mode (also cancels a deferred switch).
    InPlace,
    /// Into Full Access while a fresh session cannot be restored yet.
    Deferred,
    Restart,
}

impl Proxy {
    pub(super) async fn change_access(self: &Arc<Self>, value: &str) -> Result<(), RpcError> {
        let target = AccessMode::from_value(value).ok_or_else(|| {
            invalid_params(&format!(
                "unknown access mode `{value}`; expected default, full_access or auto_review"
            ))
        })?;
        let _serialized = self.access_lock.lock().await;
        let change = {
            let state = self.state();
            if state.access == target {
                return Ok(());
            }
            plan_change(state.child_access, target, state.all_sessions_persisted())?
        };
        match change {
            AccessChange::InPlace | AccessChange::Deferred => {
                self.state().access = target;
                Ok(())
            }
            AccessChange::Restart => self.restart_for(target).await,
        }
    }

    /// After a turn: run a deferred Full Access restart once every session is
    /// saved and idle.
    pub(super) async fn apply_pending_access(self: &Arc<Self>) -> Result<(), RpcError> {
        let _serialized = self.access_lock.lock().await;
        let target = {
            let state = self.state();
            if !state.restart_pending()
                || !state.all_sessions_persisted()
                || state.any_prompt_in_flight()
            {
                return Ok(());
            }
            state.access
        };
        self.restart_for(target).await.map_err(|error| {
            RpcError::new(
                error.code,
                format!(
                    "Cursor could not switch to {}: {}",
                    target.label(),
                    error.message
                ),
            )
        })
    }

    /// Restart preconditions shared by immediate and deferred restarts.
    async fn restart_for(self: &Arc<Self>, target: AccessMode) -> Result<(), RpcError> {
        let (busy, can_load, host_init) = {
            let state = self.state();
            (
                state.any_prompt_in_flight(),
                state.child_supports_load(),
                state.host_init.clone(),
            )
        };
        if busy {
            return Err(RpcError::internal(
                "Finish or cancel the current Cursor turn before switching into or out of Full Access.",
            ));
        }
        let host_init = host_init.ok_or_else(|| {
            RpcError::internal("Cursor Agent is not initialized; cannot change the access mode yet")
        })?;
        if !can_load {
            return Err(RpcError::internal(
                "This Cursor Agent build does not advertise `loadSession`, so Full Access cannot be toggled mid-conversation. Start a new conversation instead.",
            ));
        }
        self.restart_child(target, host_init).await
    }

    async fn restart_child(
        self: &Arc<Self>,
        target: AccessMode,
        host_init: serde_json::Value,
    ) -> Result<(), RpcError> {
        let old = self.replace_child(target).map_err(|error| {
            RpcError::internal(format!("could not restart Cursor Agent: {error}"))
        })?;
        old.terminate().await;
        let child = self.child();
        let init = child.peer.request("initialize", host_init).await?;
        authenticate(&child, &init).await?;
        self.state().child_init = Some(init);
        let mut session_ids: Vec<String> = self.state().sessions.keys().cloned().collect();
        session_ids.sort();
        for session_id in session_ids {
            self.restore_session(&session_id).await?;
        }
        Ok(())
    }

    async fn restore_session(&self, session_id: &str) -> Result<(), RpcError> {
        let (params, mode, model) = {
            let mut state = self.state();
            let Some(session) = state.sessions.get(session_id) else {
                return Ok(());
            };
            let params = json!({
                "sessionId": session_id,
                "cwd": session.cwd,
                "mcpServers": session.mcp_servers,
            });
            let mode = session.config.mode();
            let model = session.config.applied_model.clone();
            state.suppressed.insert(session_id.to_string());
            (params, mode, model)
        };
        let loaded = self.child().peer.request("session/load", params).await;
        self.state().suppressed.remove(session_id);
        let loaded = loaded.map_err(|error| {
            RpcError::new(
                error.code,
                format!(
                    "Cursor could not reload the conversation after the restart: {}",
                    error.message
                ),
            )
        })?;
        self.observe_child_options(session_id, &loaded);
        let live_mode = self
            .state()
            .sessions
            .get(session_id)
            .and_then(|s| s.config.mode());
        if let Some(mode) = mode.filter(|mode| live_mode.as_ref() != Some(mode)) {
            self.child_set_mode(session_id, &mode).await?;
        }
        if let Some(model) = model {
            self.apply_model(session_id, &model).await?;
        }
        Ok(())
    }
}

fn plan_change(
    launched: AccessMode,
    target: AccessMode,
    all_persisted: bool,
) -> Result<AccessChange, RpcError> {
    if !launched.change_needs_restart(target) {
        return Ok(AccessChange::InPlace);
    }
    if all_persisted {
        return Ok(AccessChange::Restart);
    }
    if target == AccessMode::FullAccess {
        return Ok(AccessChange::Deferred);
    }
    Err(RpcError::internal(
        "Cursor has not saved this conversation yet, so it cannot leave Full Access now. Send a first message, then switch.",
    ))
}

#[cfg(test)]
mod tests {
    use super::{plan_change, AccessChange};
    use crate::access::AccessMode::{AutoReview, Default, FullAccess};

    #[test]
    fn fresh_sessions_defer_full_access_and_refuse_leaving_it() {
        assert_eq!(
            plan_change(Default, AutoReview, false).unwrap(),
            AccessChange::InPlace
        );
        assert_eq!(
            plan_change(Default, FullAccess, true).unwrap(),
            AccessChange::Restart
        );
        assert_eq!(
            plan_change(Default, FullAccess, false).unwrap(),
            AccessChange::Deferred
        );
        assert_eq!(
            plan_change(FullAccess, Default, true).unwrap(),
            AccessChange::Restart
        );
        assert!(plan_change(FullAccess, AutoReview, false).is_err());
    }
}
