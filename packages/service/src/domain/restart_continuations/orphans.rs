//! Agent processes a killed service left running.
//!
//! A graceful stop closes every runtime. A hard kill (SIGKILL, a crash, a
//! power loss) cannot: the agent CLIs are reparented to init and keep working
//! on their turn, unsupervised. Every live agent process is therefore written
//! to `agent_process_ledger`, and the next start stops the survivors before it
//! resumes their conversations — otherwise two processes would drive the same
//! provider session.
//!
//! A pid alone is not an identity: the OS reuses them. Each row also keeps the
//! process start time, and a survivor is only stopped when the pid still
//! reports that same start time.

use crate::shared::discard::KeepFirst;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use sqlx::SqlitePool;

use crate::shared::process_table;

static LEDGER: OnceLock<SqlitePool> = OnceLock::new();

/// How long a survivor gets to exit on SIGTERM before SIGKILL.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

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

/// Stop every recorded agent process that is still the process it was, then
/// empty the ledger. Returns how many survivors were stopped.
pub(super) async fn reap(pool: &SqlitePool) -> anyhow::Result<usize> {
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT pid, identity FROM agent_process_ledger")
        .fetch_all(pool)
        .await?;
    let survivors = futures::future::join_all(rows.into_iter().map(|(pid, identity)| async move {
        let pid = u32::try_from(pid).ok()?;
        (recorded_identity(pid, &identity).await.as_deref() == Some(identity.as_str()))
            .then_some(pid)
    }))
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    // One snapshot of the process table for every survivor. Without it the
    // survivors themselves are still stopped, but not what they started.
    let parents = if survivors.is_empty() {
        Ok(HashMap::new())
    } else {
        process_table::parents().await
    };
    let empty = HashMap::new();
    let tree = parents.as_ref().unwrap_or(&empty);
    futures::future::join_all(survivors.iter().map(|pid| terminate_tree(*pid, tree))).await;
    sqlx::query("DELETE FROM agent_process_ledger")
        .execute(pool)
        .await?;
    parents.map_err(|error| {
        anyhow::anyhow!("could not find the processes the agents had started: {error}")
    })?;
    Ok(survivors.len())
}

/// When `pid` started, or `None` when no such process: a pid with the same
/// start time is the same process. Read from the kernel, so a loaded machine
/// cannot time the check out and make a survivor look gone.
async fn process_identity(pid: u32) -> Option<String> {
    process_table::start_time(pid).await
}

/// `pid`'s identity in the form `identity` was recorded in. On macOS, rows
/// written before identities came from the kernel hold what `ps -o lstart`
/// printed, in the user's locale: those are read the same way, once, since
/// every reap empties the ledger.
async fn recorded_identity(pid: u32, identity: &str) -> Option<String> {
    if cfg!(target_os = "macos") && !is_kernel_identity(identity) {
        return legacy_identity(pid).await;
    }
    process_identity(pid).await
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

/// The pids below `root` in a `pid -> parent pid` snapshot.
fn descendants_of(root: u32, parents: &HashMap<i32, i32>) -> Vec<u32> {
    let Ok(root) = i32::try_from(root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, ppid) in parents {
            if *ppid == parent && *pid != root && !found.contains(pid) {
                found.push(*pid);
                frontier.push(*pid);
            }
        }
    }
    found
        .into_iter()
        .filter_map(|pid| u32::try_from(pid).ok())
        .collect()
}

/// SIGTERM the survivor and what it started (a running command, MCP servers),
/// then SIGKILL whatever ignored it.
#[cfg(unix)]
async fn terminate_tree(root: u32, parents: &HashMap<i32, i32>) {
    let mut tree = descendants_of(root, parents);
    tree.push(root);
    tracing::warn!(
        pid = root,
        processes = tree.len(),
        "stopping an orphaned agent process"
    );
    signal_all(&tree, libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + TERMINATE_GRACE;
    while tokio::time::Instant::now() < deadline && tree.iter().any(|pid| is_alive(*pid)) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    signal_all(&tree, libc::SIGKILL);
}

#[cfg(not(unix))]
async fn terminate_tree(_root: u32, _parents: &HashMap<i32, i32>) {}

#[cfg(unix)]
fn signal_all(pids: &[u32], signal: libc::c_int) {
    for pid in pids {
        let Ok(pid) = libc::pid_t::try_from(*pid) else {
            continue;
        };
        // SAFETY: `kill` takes plain integers; a vanished pid is just ESRCH.
        unsafe {
            libc::kill(pid, signal);
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
    fn descendants_follow_the_whole_subtree_and_nothing_else() {
        let parents = HashMap::from([(10, 1), (11, 10), (12, 11), (13, 10), (20, 1), (21, 20)]);
        let mut found = descendants_of(10, &parents);
        found.sort_unstable();
        assert_eq!(found, vec![11, 12, 13]);
        assert!(descendants_of(99, &parents).is_empty());
    }

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
        let (pool, _, _) = crate::domain::schedules::repository::test_support::fixture().await;
        let mut survivor = tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut bystander = tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
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

        let status = tokio::time::timeout(Duration::from_secs(5), survivor.wait())
            .await
            .unwrap()
            .unwrap();
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
