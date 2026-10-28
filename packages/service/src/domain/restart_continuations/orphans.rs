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

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use sqlx::SqlitePool;

#[cfg(not(target_os = "linux"))]
use crate::domain::ports::scan::capture;
use crate::domain::ports::scan::parent_map;

static LEDGER: OnceLock<SqlitePool> = OnceLock::new();

/// How long a survivor gets to exit on SIGTERM before SIGKILL.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

pub(super) fn init(pool: &SqlitePool) {
    let _ = LEDGER.set(pool.clone());
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
        (process_identity(pid).await.as_deref() == Some(identity.as_str())).then_some(pid)
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
        parent_map().await
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
/// start time is the same process. Linux reads the kernel's tick count, which
/// `ps -o lstart` would round through the wall clock (and can shift by a
/// second between calls); macOS `ps` reports the kernel's own start time.
#[cfg(target_os = "linux")]
async fn process_identity(pid: u32) -> Option<String> {
    let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat"))
        .await
        .ok()?;
    start_ticks(&stat).map(str::to_string)
}

/// Field 22 of `/proc/<pid>/stat`. The command name (field 2) is in
/// parentheses and may itself contain spaces and parentheses, so fields are
/// counted from the last `)`, which is followed by field 3.
#[cfg(any(target_os = "linux", test))]
fn start_ticks(stat: &str) -> Option<&str> {
    let (_, fields) = stat.rsplit_once(')')?;
    fields.split_whitespace().nth(22 - 3)
}

#[cfg(not(target_os = "linux"))]
async fn process_identity(pid: u32) -> Option<String> {
    let output = capture("ps", &["-p", &pid.to_string(), "-o", "lstart="])
        .await
        .ok()?;
    let identity = output.trim();
    (!identity.is_empty()).then(|| identity.to_string())
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

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
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
    fn the_start_time_is_read_past_a_command_name_with_spaces() {
        let stat = "4242 (my (odd) cmd) S 1 4242 4242 0 -1 4194560 120 0 0 0 1 2 0 0 \
                    20 0 1 0 987654 1000 10";
        assert_eq!(start_ticks(stat), Some("987654"));
        assert_eq!(start_ticks("garbage"), None);
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
