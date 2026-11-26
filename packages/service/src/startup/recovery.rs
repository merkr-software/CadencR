//! Settle work the previous service process left mid-flight, before any
//! client can connect and read it.

use std::path::Path;

use tracing::info;

use crate::config::Config;
use crate::domain::{self, restart_continuations::DesktopQuitJournal};

pub(super) async fn recover_interrupted_work(
    write_pool: &sqlx::SqlitePool,
    config: &Config,
    db_path: &Path,
) -> anyhow::Result<()> {
    // The database lock is held for this entire startup. Claim the last
    // service's epoch before any continuation or other work can be dispatched.
    let journal = DesktopQuitJournal::claim(db_path, config.desktop_quit_epoch).await?;
    // Respect the same startup fence as continuation capture. A failed OS
    // inspection leaves both the cleanup proof and the quit decision available
    // for the next attempt, without dispatching a duplicate provider run.
    domain::agents::process_sessions::recover(db_path, journal.database_key()).await?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    journal.confirm_processes_stopped(db_path).await?;
    // Turns a crash left 'running' are captured for resume, then paused.
    domain::restart_continuations::recover_at_startup(
        write_pool,
        config.app_version.as_deref(),
        journal.stops_interrupted_work(),
    )
    .await?;
    journal.advance().await?;
    if config.desktop_quit_epoch.is_some() {
        crate::shared::startup_progress::emit_phase("desktop_quit_armed", "");
    }
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
