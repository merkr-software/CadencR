//! What a Claude Code CLI leaves running once it is gone.
//!
//! The CLI leads its own process group (`Options::own_process_group`), where
//! its stdio MCP servers run, and starts every Bash command as the leader of
//! a group of its own. On SIGTERM it stops its background commands itself,
//! and at the end of its input it waits for them to finish first. A CLI that
//! dies by SIGKILL (a crash, `kill -9`, a Stop its SIGTERM did not end)
//! cannot, and they keep running, reparented to init, where nothing ties
//! them to the CLI any more. So every time the CLI reports its background
//! tasks, the groups its children lead are noted with their leader's start
//! time, and once the process has exited, what is left of its own group and
//! of the noted groups whose leader still runs is stopped. Nothing is
//! stopped while the CLI lives, so the runtime hold for a background task is
//! unaffected. Not covered: a command started after the last report, a
//! group whose leader has exited (its id may belong to someone else by
//! then), and a CLI whose service died first, which the next start stops
//! with its whole tree (`restart_continuations`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::domain::ports::scan::{process_links, ProcessLinks};
use crate::domain::restart_continuations::process_identity;

/// How long what the CLI left gets to exit on SIGTERM before SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// The groups the CLI's children lead, by group id, with the start time of
/// their leader (a pid is not an identity on its own).
type NotedGroups = HashMap<u32, String>;

#[derive(Clone)]
pub(super) struct CliProcesses {
    cli: Option<u32>,
    notes: Arc<Notes>,
}

#[derive(Default)]
struct Notes {
    groups: Mutex<NotedGroups>,
    /// A scan is waiting to start, so a burst of reports costs one scan.
    scan_queued: AtomicBool,
    /// The CLI is gone: its children are init's now, nothing to note.
    exited: AtomicBool,
}

impl CliProcesses {
    /// Follow the CLI `pid`: once `exited` resolves, stop what it left.
    pub(super) fn watch(
        pid: Option<u32>,
        exited: impl Future<Output = ()> + Send + 'static,
    ) -> Self {
        let processes = Self {
            cli: pid,
            notes: Arc::default(),
        };
        let leftovers = processes.clone();
        tokio::spawn(async move {
            exited.await;
            leftovers.notes.exited.store(true, Ordering::SeqCst);
            leftovers.stop_leftovers().await;
        });
        processes
    }

    #[cfg(test)]
    pub(super) fn untracked() -> Self {
        Self {
            cli: None,
            notes: Arc::default(),
        }
    }

    /// The CLI reported its background tasks: note, in the background, the
    /// groups its children lead now, which would outlive its death.
    pub(super) fn note_background_tasks(&self) {
        let Some(cli) = self.cli else {
            return;
        };
        if self.notes.exited.load(Ordering::SeqCst)
            || self.notes.scan_queued.swap(true, Ordering::SeqCst)
        {
            // Gone, or a queued scan will see this report's processes.
            return;
        }
        let notes = Arc::clone(&self.notes);
        tokio::spawn(async move {
            // Held across the scan, so stopping the leftovers waits for it.
            let mut groups = notes.groups.lock().await;
            notes.scan_queued.store(false, Ordering::SeqCst);
            if let Err(error) = note_child_groups(cli, &mut groups).await {
                tracing::warn!(cli, %error, "could not note the processes a Claude Code CLI started");
            }
        });
    }

    async fn stop_leftovers(&self) {
        let Some(cli) = self.cli else {
            return;
        };
        let noted = std::mem::take(&mut *self.notes.groups.lock().await);
        let noted =
            futures::future::join_all(noted.into_iter().map(|(pgid, identity)| async move {
                still_the_noted_group(pgid, &identity).await.then_some(pgid)
            }))
            .await;
        let groups = std::iter::once(cli).chain(noted.into_iter().flatten());
        futures::future::join_all(groups.map(|pgid| stop_group(cli, pgid))).await;
    }
}

async fn note_child_groups(cli: u32, groups: &mut NotedGroups) -> anyhow::Result<()> {
    let links = process_links().await?;
    // A group that is gone may see its id reused from now on.
    let live: HashSet<i32> = links.values().map(|links| links.pgid).collect();
    groups.retain(|pgid, _| i32::try_from(*pgid).is_ok_and(|pgid| live.contains(&pgid)));
    for leader in child_group_leaders(cli, &links) {
        // Read again each time: a reused id is a new command.
        match process_identity(leader).await {
            Some(identity) => groups.insert(leader, identity),
            None => groups.remove(&leader),
        };
    }
    Ok(())
}

/// The children of `cli` that lead a process group: its Bash commands.
fn child_group_leaders(cli: u32, links: &HashMap<i32, ProcessLinks>) -> Vec<u32> {
    let Ok(cli) = i32::try_from(cli) else {
        return Vec::new();
    };
    links
        .iter()
        .filter(|(pid, links)| links.ppid == cli && links.pgid == **pid)
        .filter_map(|(pid, _)| u32::try_from(*pid).ok())
        .collect()
}

/// Whether `pgid` is still the live group noted with a leader started at
/// `identity`. Once the leader has exited, the group's id may have been
/// reused since it was noted, so a group without its leader is left alone.
async fn still_the_noted_group(pgid: u32, identity: &str) -> bool {
    group_alive(pgid) && process_identity(pgid).await.as_deref() == Some(identity)
}

#[cfg(unix)]
fn group_alive(pgid: u32) -> bool {
    crate::shared::process_group::process_group_alive(pgid)
}

#[cfg(not(unix))]
fn group_alive(_pgid: u32) -> bool {
    false
}

#[cfg(unix)]
async fn stop_group(cli: u32, pgid: u32) {
    if !group_alive(pgid) {
        return;
    }
    tracing::info!(
        cli,
        pgid,
        "stopping processes a gone Claude Code CLI left running"
    );
    if let Err(error) = crate::shared::process_group::stop_process_group(pgid, STOP_GRACE).await {
        tracing::warn!(cli, pgid, %error, "could not stop processes a Claude Code CLI left running");
    }
}

#[cfg(not(unix))]
async fn stop_group(_cli: u32, _pgid: u32) {}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Stdio;

    use super::*;
    use crate::shared::test_processes::KillOnDrop;

    #[test]
    fn only_children_leading_a_group_are_noted() {
        let links = HashMap::from([
            // The CLI, leading its own group, and an MCP server in it.
            (100, ProcessLinks { ppid: 1, pgid: 100 }),
            (
                101,
                ProcessLinks {
                    ppid: 100,
                    pgid: 100,
                },
            ),
            // A Bash command's shell, and the sleep it runs.
            (
                200,
                ProcessLinks {
                    ppid: 100,
                    pgid: 200,
                },
            ),
            (
                201,
                ProcessLinks {
                    ppid: 200,
                    pgid: 200,
                },
            ),
            // Someone else's group leader.
            (300, ProcessLinks { ppid: 1, pgid: 300 }),
        ]);
        assert_eq!(child_group_leaders(100, &links), vec![200]);
        assert!(child_group_leaders(999, &links).is_empty());
    }

    /// `sleep 30` leading a group of its own, as Claude Code starts a Bash
    /// command.
    fn group_leading_sleep() -> tokio::process::Child {
        let mut command = tokio::process::Command::new("sleep");
        command.arg("30").stdin(Stdio::null()).kill_on_drop(true);
        crate::shared::process_group::lead_new_process_group(&mut command);
        command.spawn().unwrap()
    }

    async fn exits(child: &mut tokio::process::Child) -> bool {
        crate::shared::process_group::wait_bounded(child, Duration::from_secs(5))
            .await
            .is_ok()
    }

    async fn gone(pid: u32) -> bool {
        // An orphan is reaped by init asynchronously.
        for _ in 0..250 {
            if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test]
    async fn a_scan_notes_the_groups_children_lead() {
        let child = group_leading_sleep();
        let pid = child.id().unwrap();
        let _cleanup = KillOnDrop::default().group(pid);

        // This test process stands in for the CLI.
        let mut groups = NotedGroups::new();
        note_child_groups(std::process::id(), &mut groups)
            .await
            .unwrap();
        assert!(groups.contains_key(&pid), "{groups:?}");
        assert_eq!(groups.get(&pid), process_identity(pid).await.as_ref());
    }

    #[tokio::test]
    async fn a_group_whose_leader_exited_is_left_alone() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("member.pid");
        let mut leader = tokio::process::Command::new("/bin/sh");
        leader
            .args(["-c", r#"sleep 30 & echo $! > "$0.tmp" && mv "$0.tmp" "$0""#])
            .arg(&pid_file)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        crate::shared::process_group::lead_new_process_group(&mut leader);
        let mut leader = leader.spawn().unwrap();
        let pgid = leader.id().unwrap();
        let _cleanup = KillOnDrop::default().group(pgid);
        let identity = process_identity(pgid).await.unwrap();
        assert!(still_the_noted_group(pgid, &identity).await);

        leader.wait().await.unwrap();
        assert!(group_alive(pgid), "its member still runs");
        assert!(!still_the_noted_group(pgid, &identity).await);
    }

    #[tokio::test]
    async fn a_gone_cli_takes_no_more_notes() {
        let processes = CliProcesses {
            cli: Some(std::process::id()),
            notes: Arc::default(),
        };
        processes.notes.exited.store(true, Ordering::SeqCst);
        processes.note_background_tasks();
        assert!(!processes.notes.scan_queued.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_killed_cli_leaves_nothing_behind() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("mcp.pid");
        // A CLI leading its group with an MCP-like child in it.
        let mut cli = tokio::process::Command::new("/bin/sh");
        cli.args([
            "-c",
            r#"sleep 30 & echo $! > "$0.tmp" && mv "$0.tmp" "$0"; wait"#,
        ])
        .arg(&pid_file)
        .stdin(Stdio::null())
        .kill_on_drop(true);
        crate::shared::process_group::lead_new_process_group(&mut cli);
        let mut cli = cli.spawn().unwrap();
        let cli_pid = cli.id().unwrap();
        let mut command = group_leading_sleep();
        let mut bystander = group_leading_sleep();
        let (command_pid, bystander_pid) = (command.id().unwrap(), bystander.id().unwrap());
        let _cleanup = KillOnDrop::default()
            .group(cli_pid)
            .group(command_pid)
            .group(bystander_pid);
        for _ in 0..250 {
            if pid_file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mcp: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        let (exited_tx, exited_rx) = tokio::sync::oneshot::channel::<()>();
        let processes = CliProcesses::watch(Some(cli_pid), async move {
            let _ = exited_rx.await;
        });
        processes.notes.groups.lock().await.extend([
            (command_pid, process_identity(command_pid).await.unwrap()),
            // Noted once, then gone; its id now belongs to someone else.
            (bystander_pid, "Thu Jan  1 00:00:00 1970".to_string()),
        ]);
        // Killed as `kill -9` would: nothing of what it started dies with it.
        unsafe { libc::kill(cli_pid as libc::pid_t, libc::SIGKILL) };
        cli.wait().await.unwrap();
        assert!(command.try_wait().unwrap().is_none());

        exited_tx.send(()).unwrap();
        assert!(exits(&mut command).await, "the background command survived");
        assert!(gone(mcp).await, "the CLI's own group survived");
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "a reused group id is never signalled"
        );
    }
}
