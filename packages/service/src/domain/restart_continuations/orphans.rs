//! Compatibility ledger for agent processes without a durable session anchor.
//!
//! Interactive transports record their session in `agents::process_sessions`
//! at launch. That proof outlives the reader and the leader. This older ledger
//! can only verify a live original leader and its remaining tree.
//!
//! A pid alone is not an identity: the OS reuses them. Each row also keeps the
//! process start time, and a survivor is only stopped when the pid still
//! reports that same start time.

use crate::shared::discard::KeepFirst;
use std::sync::OnceLock;
use std::time::Duration;

use sqlx::SqlitePool;

use crate::shared::process_table;

static LEDGER: OnceLock<SqlitePool> = OnceLock::new();

/// How long `ps` gets for a row recorded by an earlier version.
const LEGACY_PS_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn init(pool: &SqlitePool) {
    LEDGER.keep_first(pool.clone());
}

/// Remember a live agent process. Returns the ledger row to [`forget`] once
/// the process's runtime has ended. `None` when the ledger is not initialized
/// (tests, MCP subprocess mode) or the process cannot be identified.
pub async fn record(session_id: i64, pid: u32) -> Option<i64> {
    let pool = LEDGER.get()?;
    if crate::domain::agents::process_sessions::owns(pid) {
        return None;
    }
    let identity = process_identity(pid).await?;
    match sqlx::query_scalar::<_, i64>(
        "INSERT INTO agent_process_ledger (session_id, pid, identity) VALUES (?, ?, ?)
         RETURNING id",
    )
    .bind(session_id)
    .bind(i64::from(pid))
    .bind(identity)
    .fetch_one(pool)
    .await
    {
        Ok(id) => Some(id),
        Err(error) => {
            // The turn runs either way; only crash cleanup for it is lost.
            tracing::warn!(session_id, pid, %error, "failed to record an agent process");
            None
        }
    }
}

pub async fn forget(entry: Option<i64>) {
    let (Some(id), Some(pool)) = (entry, LEDGER.get()) else {
        return;
    };
    if let Err(error) = sqlx::query("DELETE FROM agent_process_ledger WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
    {
        tracing::warn!(id, %error, "failed to forget an ended agent process");
    }
}

/// Stop every verified survivor and forget only entries whose cleanup settled.
pub(super) async fn reap(pool: &SqlitePool) -> anyhow::Result<usize> {
    let rows: Vec<(i64, i64, String)> =
        sqlx::query_as("SELECT id, pid, identity FROM agent_process_ledger")
            .fetch_all(pool)
            .await?;
    let outcomes =
        futures::future::join_all(rows.into_iter().map(|(id, pid, identity)| async move {
            let result = match u32::try_from(pid) {
                Ok(pid) => stop_recorded_tree(pid, &identity).await,
                Err(_) => Ok(false),
            };
            (id, result)
        }))
        .await;
    let mut stopped = 0;
    let mut failure = None;
    for (id, result) in outcomes {
        match result {
            Ok(reaped) => {
                stopped += usize::from(reaped);
                sqlx::query("DELETE FROM agent_process_ledger WHERE id = ?")
                    .bind(id)
                    .execute(pool)
                    .await?;
            }
            Err(error) => {
                tracing::warn!(id, %error, "could not stop an orphaned provider");
                failure = Some(error);
            }
        }
    }
    if let Some(error) = failure {
        return Err(error.into());
    }
    Ok(stopped)
}

async fn stop_recorded_tree(pid: u32, recorded: &str) -> std::io::Result<bool> {
    let Some(identity) = process_identity(pid).await else {
        return Ok(false);
    };
    let matches = if cfg!(target_os = "macos") && !is_kernel_identity(recorded) {
        legacy_identity(pid).await.as_deref() == Some(recorded)
    } else {
        identity == recorded
    };
    if !matches {
        return Ok(false);
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    return process_table::stop_verified_tree(pid, identity).await;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Ok(false)
}

/// When `pid` started, or `None` when no such process: a pid with the same
/// start time is the same process. Read from the kernel, so a loaded machine
/// cannot time the check out and make a survivor look gone.
async fn process_identity(pid: u32) -> Option<String> {
    process_table::start_time(pid).await
}

/// Kernel identities are digits: seconds and microseconds on macOS
/// (`1731700000.123456`), clock ticks on Linux.
fn is_kernel_identity(identity: &str) -> bool {
    !identity.is_empty()
        && identity
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
}

/// What `ps -o lstart` prints for `pid`, `None` when it prints nothing (no
/// such process) or cannot run.
async fn legacy_identity(pid: u32) -> Option<String> {
    let mut command = tokio::process::Command::new("ps");
    command
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    match crate::shared::bounded_command::capture_bounded(command, LEGACY_PS_TIMEOUT).await {
        Ok(output) => {
            let identity = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!identity.is_empty()).then_some(identity)
        }
        Err(error) => {
            tracing::warn!(pid, %error, "could not read a recorded agent process's start time");
            None
        }
    }
}

/// Whether a process with `pid` exists (a zombie not yet reaped counts).
#[cfg(unix)]
pub(crate) fn is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_recorded_through_ps_are_told_from_kernel_identities() {
        assert!(is_kernel_identity("1731700000.123456"));
        assert!(is_kernel_identity("987654"));
        assert!(!is_kernel_identity("Mon Nov 16 01:46:00 2026"));
        assert!(!is_kernel_identity(""));
    }

    #[tokio::test]
    async fn a_live_process_has_a_stable_identity() {
        let pid = std::process::id();
        let first = process_identity(pid).await;
        assert!(first.is_some());
        assert_eq!(first, process_identity(pid).await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reap_stops_a_recorded_survivor_and_spares_a_reused_pid() {
        use crate::shared::{process_group::wait_bounded, test_processes::sleeping_child_command};

        let (pool, _, _) = crate::domain::schedules::repository::test_support::fixture().await;
        let mut survivor = sleeping_child_command().spawn().unwrap();
        let mut bystander = sleeping_child_command().spawn().unwrap();
        let survivor_pid = survivor.id().unwrap();
        let bystander_pid = bystander.id().unwrap();
        let identity = process_identity(survivor_pid).await.unwrap();
        sqlx::query("INSERT INTO agent_process_ledger (session_id, pid, identity) VALUES (1, ?, ?), (2, ?, 'Thu Jan  1 00:00:00 1970')")
            .bind(i64::from(survivor_pid))
            .bind(identity)
            .bind(i64::from(bystander_pid))
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(reap(&pool).await.unwrap(), 1);

        let status = wait_bounded(&mut survivor, Duration::from_secs(5))
            .await
            .expect("the recorded survivor must exit");
        assert!(!status.success());
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "a reused pid is never signalled"
        );
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_process_ledger")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
        bystander.kill().await.unwrap();
    }
}
