//! Initialize only an unconfigured conversation. Once written, its own row
//! drives both reconnects and spawns even as later prompts change the workspace.
use super::SessionRow;
use crate::domain::agents::{
    adapter::RuntimeConfigOverrides, runtime_adapter, selection::PromptedSelection,
};
use crate::error::AppError;
use sqlx::SqlitePool;
use std::path::Path;

impl SessionRow {
    /// Resolve at the feature's runtime cwd. Commit only after runtime configuration succeeds.
    pub(in crate::domain::ws_session) async fn inherit_last_prompt(
        &mut self,
        pool: &SqlitePool,
        cwd: &Path,
    ) -> Result<bool, AppError> {
        if self.runtime_provider.is_some()
            || self.runtime_session_id.is_some()
            || self.profile.is_some()
            || self.runtime_overrides.is_some()
            || self.model.is_some()
            || self.thinking_effort.is_some()
            || self.permission_mode.is_some()
            || self.fast_mode
        {
            return Ok(false);
        }
        let Some(saved) =
            PromptedSelection::for_new_session(pool, Some(cwd), Some(self.feature_id)).await?
        else {
            return Ok(false);
        };
        let mut overrides = RuntimeConfigOverrides::default();
        if runtime_adapter(&saved.provider)
            .is_some_and(|adapter| adapter.supports_profile_config_inheritance())
        {
            overrides = RuntimeConfigOverrides {
                model: saved.model.clone(),
                thinking_effort: saved.thinking_effort.clone(),
                fast_mode: Some(saved.fast_mode),
            };
        }
        // As with a provider switch, the document identifies an initialized set of
        // controls. An empty effort in those controls is the provider default.
        self.runtime_overrides =
            Some(serde_json::to_string(&overrides).expect("runtime overrides serialize"));
        self.runtime_provider = Some(saved.provider);
        self.model = saved.model;
        self.profile = saved.profile;
        self.thinking_effort = saved.thinking_effort;
        self.fast_mode = saved.fast_mode;
        self.permission_mode = saved.permission_mode;
        Ok(true)
    }

    pub(in crate::domain::ws_session) async fn persist_inherited_controls(
        &self,
        pool: &SqlitePool,
    ) -> Result<(), AppError> {
        let updated = sqlx::query(
            "UPDATE agent_sessions SET runtime_provider = ?, model = ?, profile = ?,
             thinking_effort = ?, fast_mode = ?, runtime_overrides = ?, permission_mode = ?
             WHERE id = ? AND runtime_provider IS NULL AND runtime_session_id IS NULL
             AND model IS NULL AND profile IS NULL AND thinking_effort IS NULL AND fast_mode = 0
             AND runtime_overrides IS NULL AND permission_mode IS NULL",
        )
        .bind(&self.runtime_provider)
        .bind(&self.model)
        .bind(&self.profile)
        .bind(&self.thinking_effort)
        .bind(self.fast_mode)
        .bind(&self.runtime_overrides)
        .bind(&self.permission_mode)
        .bind(self.id)
        .execute(pool)
        .await?;
        if updated.rows_affected() == 0 {
            let current = super::WsSessionPersistence::get_session_row(pool, self.id).await?;
            if !current.is_some_and(|r| {
                r.runtime_provider == self.runtime_provider
                    && r.model == self.model
                    && r.profile == self.profile
                    && r.thinking_effort == self.thinking_effort
                    && r.fast_mode == self.fast_mode
                    && r.runtime_overrides == self.runtime_overrides
                    && r.permission_mode == self.permission_mode
            }) {
                return Err(AppError::Conflict(
                    "Conversation controls changed during initialization".into(),
                ));
            }
        }
        Ok(())
    }
}
