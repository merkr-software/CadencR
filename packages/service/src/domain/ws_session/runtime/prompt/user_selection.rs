//! Remember the controls of a newly delivered user message.
use std::time::Instant;

use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeSpawnConfig};
pub(in crate::domain::ws_session) use crate::domain::agents::selection::PromptedSelection;
use crate::domain::ws_session::runtime::{output::OutputTarget, SdkHandle};

impl PromptedSelection {
    pub(in crate::domain::ws_session) fn active(handle: &SdkHandle) -> Self {
        Self {
            provider: handle.runtime_provider.clone(),
            model: handle.desired_model.clone(),
            profile: handle.spawned_claude_profile.clone(),
            thinking_effort: handle.spawned_thinking_effort.clone(),
            fast_mode: handle.config.fast_mode,
        }
    }

    pub(in crate::domain::ws_session) fn pending(
        provider: &str,
        config: &RuntimeSpawnConfig,
    ) -> Self {
        Self {
            provider: provider.to_owned(),
            model: config.model.clone(),
            profile: config.profile.clone(),
            thinking_effort: config.thinking_effort.clone(),
            fast_mode: config.fast_mode,
        }
    }

    pub(in crate::domain::ws_session) async fn delivered(
        mut self,
        session: &dyn AgentRuntimeSession,
    ) -> DeliveredSelection {
        let accepted = Instant::now();
        if let Some(config) = session.delivered_turn_config().await {
            self.model = config.model;
            self.thinking_effort = config.thinking_effort;
            self.fast_mode = config.fast_mode;
        }
        DeliveredSelection {
            accepted,
            selection: self,
        }
    }
}

pub(in crate::domain::ws_session) struct DeliveredSelection {
    accepted: Instant,
    selection: PromptedSelection,
}

impl DeliveredSelection {
    pub(in crate::domain::ws_session) async fn remember(
        self,
        output: &impl OutputTarget,
        correlation_id: &str,
    ) {
        // Follow-ups release their runtime guard before writing. A different conversation
        // can finish saving a newer delivery in the meantime.
        static LAST_SAVED: tokio::sync::Mutex<Option<Instant>> =
            tokio::sync::Mutex::const_new(None);
        let mut last = LAST_SAVED.lock().await;
        if last.is_some_and(|time| time > self.accepted) {
            return;
        }
        match self.selection.remember().await {
            Ok(()) => *last = Some(self.accepted),
            Err(error) => output.report_warning(
                "LAST_USED_MODEL_SAVE_FAILED",
                &format!("Couldn't remember the settings for new conversations: {error}"),
                correlation_id,
            ),
        }
    }
}
