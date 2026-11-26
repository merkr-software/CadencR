//! Process trees owned by interactive provider launches. Provider protocol
//! close ends the transport; only the OS observer can confirm the work stopped.

use std::path::Path;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod journal;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod owned;

pub(crate) async fn recover(database: &Path, database_key: &str) -> anyhow::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return owned::recover(database, database_key).await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (database, database_key);
        Ok(())
    }
}

pub(crate) async fn reap_for_quit(database: &Path, database_key: &str) -> anyhow::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return journal::Journal::reap_for_quit(
        database,
        database_key,
        crate::shared::process_table::BootIdentity::current(),
    )
    .await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (database, database_key);
        anyhow::bail!("Could not verify agent process shutdown on this platform")
    }
}

pub(crate) fn owns(pid: u32) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return owned::owns(pid);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        false
    }
}

pub(crate) fn new() -> Option<cli_discovery::ChildSession> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        owned::new_session()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

pub(crate) fn for_runtime(
    config: &super::adapter::RuntimeSpawnConfig,
) -> Option<cli_discovery::ChildSession> {
    config.purpose.is_none().then(new).flatten()
}

pub(crate) fn retry_failed_drains() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    owned::retry_failed_drains();
}

pub(crate) async fn confirm_stopped() -> anyhow::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return owned::confirm_stopped().await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Ok(())
}

pub(crate) async fn pinned_session_has_work(pid: u32) -> std::io::Result<bool> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return crate::shared::process_table::pinned_session_has_work(pid, owned::anchor_of(pid)).await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Ok(true)
    }
}
