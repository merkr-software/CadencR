use axum::http::StatusCode;
use tokio::sync::broadcast;

use super::events::Update;
use super::handshake;
use super::request::Budget;
use super::{BackendLaunch, BackendSupervisor, Key};
use crate::domain::plugin_tabs::grants::GrantStore;
use crate::error::AppError;

impl BackendSupervisor {
    /// Subscribe before starting, so even immediate post-ready events are retained.
    /// No automatic restart: only an explicit request starts a replacement.
    pub async fn subscribe(
        &self,
        grants: &GrantStore,
        launch: BackendLaunch,
    ) -> Result<broadcast::Receiver<Update>, AppError> {
        if launch.backend.protocol != 2 {
            return Err(AppError::coded(
                StatusCode::BAD_REQUEST,
                "PLUGIN_BACKEND_EVENTS_UNSUPPORTED",
                "backend event subscriptions require native protocol 2",
            ));
        }
        let rx = {
            let mut slots = self.slots.lock().await;
            if slots.closed {
                return Err(super::quitting());
            }
            slots
                .by_key
                .entry(Key::of(&launch))
                .or_default()
                .events
                .subscribe()
        };
        let (this, grants) = (self.clone(), grants.clone());
        Budget::starting_now(crate::domain::plugin_tabs::exec::DEFAULT_TIMEOUT)
            .wait_detached("subscribe", async move {
                let running = this.ensure_running(&grants, &launch).await?;
                handshake::wait_ready(&running.handshake).await
            })
            .await?;
        Ok(rx)
    }
}
