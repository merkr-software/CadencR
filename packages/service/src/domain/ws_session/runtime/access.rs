use sqlx::SqlitePool;

use crate::domain::agents::adapter::{parse_access_mode_wire, RuntimeAccessMode};
use crate::domain::agents::runtime_adapter;

pub(in crate::domain::ws_session) async fn configured_access_mode(
    provider_id: &str,
    read_pool: &SqlitePool,
) -> Option<RuntimeAccessMode> {
    runtime_adapter(provider_id)?
        .configured_access_mode(read_pool)
        .await
}

pub(in crate::domain::ws_session) fn runtime_access_mode(
    provider_id: &str,
    stored_mode: Option<&str>,
    configured_mode: Option<RuntimeAccessMode>,
) -> Option<RuntimeAccessMode> {
    let adapter = runtime_adapter(provider_id)?;
    let mode = stored_mode
        .and_then(parse_access_mode_wire)
        .or(configured_mode)?;
    adapter.supports_access_mode(&mode).then_some(mode)
}

#[cfg(test)]
mod tests {
    use super::runtime_access_mode;
    use crate::domain::agents::adapter::RuntimeAccessMode;

    #[test]
    fn resolves_access_modes_only_for_supporting_providers() {
        assert_eq!(
            runtime_access_mode("cursor", Some("autoReview"), None),
            Some(RuntimeAccessMode::AutoReview)
        );
        assert_eq!(
            runtime_access_mode("codex_cli", Some("fullAccess"), None),
            Some(RuntimeAccessMode::FullAccess)
        );
        assert_eq!(
            runtime_access_mode(
                "claude_code",
                Some("fullAccess"),
                Some(RuntimeAccessMode::Default)
            ),
            None
        );
    }
}
