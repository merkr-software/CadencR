use sqlx::SqlitePool;

use crate::domain::agents::adapter::RuntimeAccessMode;
use crate::domain::agents::codex::{parse_access_mode, PROVIDER_ID as CODEX_PROVIDER_ID};

pub(super) async fn configured_access_mode(read_pool: &SqlitePool) -> String {
    crate::domain::agents::codex::configured_access_mode(read_pool).await
}

pub(super) fn runtime_access_mode(
    provider_id: &str,
    stored_mode: Option<&str>,
    configured_mode: &str,
) -> Option<RuntimeAccessMode> {
    if provider_id != CODEX_PROVIDER_ID {
        return None;
    }
    Some(parse_access_mode(stored_mode.or(Some(configured_mode))))
}
