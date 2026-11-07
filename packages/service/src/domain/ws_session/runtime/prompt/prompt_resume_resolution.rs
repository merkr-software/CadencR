use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use sqlx::SqlitePool;

use super::super::session_init_resume::checked_resume_session_id;

pub(in crate::domain::ws_session) async fn refresh_resume_session_id_from_db(
    options: &mut RuntimeSpawnConfig,
    read_pool: &SqlitePool,
    db_session_id: i64,
    provider_id: &str,
) -> Result<Option<String>, String> {
    let previous_resume_session_id = options.resume_session_id.clone();
    let Some(row) = WsSessionPersistence::get_session_row(read_pool, db_session_id).await else {
        return Ok(None);
    };
    let resolved_resume_session_id = match crate::domain::agents::runtime_adapter(provider_id) {
        Some(adapter) => checked_resume_session_id()
            .adapter(&*adapter)
            .provider_id(provider_id)
            .maybe_row_runtime_provider(row.runtime_provider.as_deref())
            .maybe_runtime_session_id(row.runtime_session_id.as_deref())
            .call()?,
        None => None,
    };
    options.resume_session_id = resolved_resume_session_id.clone();
    Ok(options
        .resume_session_id
        .as_ref()
        .filter(|sid| previous_resume_session_id.as_ref() != Some(*sid))
        .cloned())
}
