use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use sqlx::SqlitePool;

use super::super::session_init_resume::resume_session_id_for_provider;

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
    if row
        .runtime_provider
        .as_deref()
        .is_none_or(|id| id == provider_id)
    {
        if let Some(saved) = row.runtime_session_id.as_deref() {
            if let Some(reason) = crate::domain::agents::runtime_adapter(provider_id)
                .and_then(|adapter| adapter.resume_session_rejection(saved))
            {
                return Err(reason);
            }
        }
    }
    let resolved_resume_session_id = resume_session_id_for_provider(
        provider_id,
        row.runtime_provider.as_deref(),
        row.runtime_session_id.as_deref(),
    );
    options.resume_session_id = resolved_resume_session_id.clone();
    Ok(options
        .resume_session_id
        .as_ref()
        .filter(|sid| previous_resume_session_id.as_ref() != Some(*sid))
        .cloned())
}
