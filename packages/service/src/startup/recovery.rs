//! Settle work the previous service process left mid-flight, before any
//! client can connect and read it.

use tracing::info;

use crate::domain;

pub(super) async fn recover_interrupted_work(
    write_pool: &sqlx::SqlitePool,
    app_version: Option<&str>,
) -> anyhow::Result<()> {
    // Turns a crash left 'running' are captured for resume, then paused.
    domain::restart_continuations::recover_at_startup(write_pool, app_version).await;
    let recovered_shell_context =
        domain::ws_session::handler::recover_user_shell_context(write_pool)
            .await
            .map_err(anyhow::Error::msg)?;
    if recovered_shell_context > 0 {
        info!(
            recovered_shell_context,
            "recovered interrupted user shell context"
        );
    }
    let recovered = domain::sessions::message_dispatch::recover_orphaned_claims(write_pool).await?;
    if recovered > 0 {
        info!(recovered, "recovered orphaned message delivery claims");
    }
    let interrupted_prompts =
        domain::prompt_queue::store::recover_interrupted_deliveries(write_pool).await?;
    if interrupted_prompts > 0 {
        info!(
            interrupted_prompts,
            "marked interrupted queued prompts as failed"
        );
    }
    Ok(())
}
