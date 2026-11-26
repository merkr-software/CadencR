use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use futures::StreamExt;
use uuid::Uuid;

use super::{journal_directory, BootIdentity, Journal};

impl Journal {
    pub(in crate::domain::agents::process_sessions) async fn reap(&self) -> Result<()> {
        self.reap_entries(entry_ids(self.directory.clone()).await?)
            .await
    }

    /// The cleanup-only mode needs no boot identity when there is no proof
    /// to inspect. Discover the same entries before opening the boot scope.
    pub(in crate::domain::agents::process_sessions) async fn reap_for_quit(
        database: &Path,
        database_key: &str,
        boot: impl Future<Output = io::Result<BootIdentity>>,
    ) -> Result<()> {
        let directory = journal_directory(database, database_key)?;
        let ids = entry_ids(directory.clone()).await?;
        if ids.is_empty() {
            return Ok(());
        }
        Self::new(directory, boot.await?).reap_entries(ids).await
    }

    async fn reap_entries(&self, ids: Vec<Uuid>) -> Result<()> {
        let outcomes = futures::stream::iter(ids)
            .map(|id| self.finish(id))
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        for outcome in outcomes {
            outcome?;
        }
        Ok(())
    }
}

async fn entry_ids(directory: PathBuf) -> Result<Vec<Uuid>> {
    tokio::task::spawn_blocking(move || entries(&directory)).await?
}

fn entries(directory: &Path) -> Result<Vec<Uuid>> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) => anyhow::ensure!(metadata.is_dir(), "invalid process journal directory"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    }
    let mut ids = Vec::new();
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            let id = path
                .file_stem()
                .and_then(|name| name.to_str())
                .context("invalid process journal filename")?;
            ids.push(id.parse().context("invalid process journal identifier")?);
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::pin::Pin;
    use std::process::Stdio;
    use std::sync::{Arc, OnceLock};
    use std::time::Duration;

    use cli_discovery::{AnchorRecord, ChildSession, ChildSessionObserver};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;

    use super::*;
    use crate::domain::agents::process_sessions::journal::{file, Lease};
    use crate::shared::atomic_file::write_atomic_private;
    use crate::shared::process_table::{owned_process_is_live, start_time};

    // Use the same launch messages in this unit test, without requiring the
    // service binary to have been built. An integration test checks the
    // actual binary's private launcher entry point.
    const FIXTURE_LAUNCHER: &str = r#"#!/usr/bin/env python3
import os, signal, struct, sys
assert sys.argv[1] == '--internal-owned-provider-launch'
exec_status = int(os.environ.pop('CADENCR_OWNED_PROVIDER_EXEC_FD'))
os.set_inheritable(exec_status, False)
waiting, approve = os.pipe()
ready, announce = os.pipe()
first = os.fork()
if first == 0:
    os.close(exec_status)
    os.close(approve)
    os.close(ready)
    if os.fork() != 0:
        os._exit(0)
    os.setpgid(0, 0)
    os.dup2(waiting, 0)
    for fd in (waiting, 1, 2):
        os.close(fd)
    os.write(announce, struct.pack('=I', os.getpid()))
    if os.read(0, 1) != b'\x01':
        os._exit(1)
    os.write(announce, b'\x01')
    os.close(announce)
    signal.alarm(30)
    while True:
        signal.pause()
os.close(waiting)
os.close(announce)
os.waitpid(first, 0)
os.write(1, os.read(ready, 4))
assert os.read(0, 1) == b'\x01'
def read_exact(count):
    result = b''
    while len(result) < count:
        chunk = os.read(0, count - len(result))
        assert chunk
        result += chunk
    return result
assert 'OWNED_FIXTURE_ENV' not in os.environ
size, = struct.unpack('=I', read_exact(4))
target_env = dict(item.split(b'=', 1) for item in read_exact(size).split(b'\0') if item)
assert target_env[b'OWNED_FIXTURE_ENV'] == b'fixture=provider'
os.write(approve, b'\x01')
assert os.read(ready, 1) == b'\x01'
os.write(1, b'\x01')
os.execvpe(sys.argv[2], sys.argv[2:], target_env)
"#;

    const WORKERS: &str = r#"
import os, signal, sys, time
from pathlib import Path

root = Path(sys.argv[1])

def heartbeat(name):
    end = time.monotonic() + 30
    with (root / name).open('a', buffering=1) as counter:
        while time.monotonic() < end and not (root / 'finish').exists():
            print(os.getppid(), file=counter)
            time.sleep(0.025)

if sys.argv[2] == 'witness':
    os.setsid()
    heartbeat('witness')
    sys.exit(0)

def start_worker(name, detached):
    ready, acknowledge = os.pipe()
    worker = os.fork()
    if worker == 0:
        os.close(ready)
        if detached:
            os.setsid()
        else:
            os.setpgid(0, 0)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for fd in (0, 1, 2):
            os.close(fd)
        os.write(acknowledge, b'!')
        os.close(acknowledge)
        heartbeat(name)
        os._exit(0)
    os.close(acknowledge)
    assert os.read(ready, 1) == b'!'
    os.close(ready)
    return worker

print(start_worker('owned', False), start_worker('detached', True), flush=True)
assert sys.stdin.readline() == 'exit\n'
"#;

    struct CrashHarness {
        journal: Journal,
        lease: OnceLock<Lease>,
    }

    impl ChildSessionObserver for CrashHarness {
        fn started(&self, _: u32) {}

        fn before_reap(&self, _: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            panic!("startup recovery must have no live observer from the dead service");
        }

        fn record_anchor(&self, leader: u32, anchor: u32) -> AnchorRecord<'_> {
            Box::pin(async move {
                let lease = self
                    .journal
                    .record(leader, anchor)
                    .await
                    .map_err(io::Error::other)?;
                assert!(self.lease.set(lease).is_ok());
                Ok(())
            })
        }
    }

    async fn await_counter(path: &Path, min: usize) -> Vec<u32> {
        tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                let lines: Vec<u32> = fs::read_to_string(path)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| line.parse().ok())
                    .collect();
                if lines.len() >= min {
                    return lines;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    struct OrphanedRun {
        directory: std::path::PathBuf,
        sid: u32,
        worker: u32,
        detached: u32,
        anchor: u32,
        record: std::path::PathBuf,
        proof: String,
        writes_before_quit: usize,
    }

    async fn orphan_run(directory: &Path, launcher: &Path, journal: &Journal) -> OrphanedRun {
        fs::create_dir(directory).unwrap();
        let observer = Arc::new(CrashHarness {
            journal: journal.clone(),
            lease: OnceLock::new(),
        });
        let session = ChildSession::with_anchor(observer.clone(), launcher.to_owned());
        let mut provider = cli_discovery::session_command("python3", Some(&session));
        provider
            .args(["-c", WORKERS])
            .arg(directory)
            .arg("provider")
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("OWNED_FIXTURE_ENV", "fixture=provider")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        let mut leader = session.spawn(provider).await.unwrap();
        let sid = leader.id().unwrap();
        let lease = observer.lease.get().unwrap();
        let anchor = lease.anchor.anchor_pid() as u32;
        let record = file(&journal.directory, lease.id);
        let proof = fs::read_to_string(&record).unwrap();

        let mut stdout = BufReader::new(leader.stdout.take().unwrap());
        let mut worker = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut worker))
            .await
            .unwrap()
            .unwrap();
        let [worker, detached]: [u32; 2] = worker
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let owned_count = directory.join("owned");
        assert_eq!(await_counter(&owned_count, 1).await[0], sid);
        await_counter(&directory.join("detached"), 1).await;

        leader
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"exit\n")
            .await
            .unwrap();
        // Reap the leader without invoking the original service's cleanup.
        assert!(leader.wait().await.unwrap().success());
        assert!(start_time(sid).await.is_none());
        assert!(start_time(worker).await.is_some());
        let writes_before_quit = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let parents = await_counter(&owned_count, 1).await;
                if parents.last().is_some_and(|&parent| parent != sid) {
                    return parents.len();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        OrphanedRun {
            directory: directory.to_owned(),
            sid,
            worker,
            detached,
            anchor,
            record,
            proof,
            writes_before_quit,
        }
    }

    #[tokio::test]
    async fn cold_quit_stops_both_reparented_runs_without_reopening_the_app() {
        use crate::domain::restart_continuations::{finish_cold_quit, DesktopQuitJournal};

        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("database/work.db");
        fs::create_dir(database.parent().unwrap()).unwrap();
        fs::File::create(&database).unwrap();
        let database = fs::canonicalize(database).unwrap();
        let boot = BootIdentity::fixture();
        let original_service = crate::startup_lock::acquire_db_lock(&database).unwrap();
        let epoch = Uuid::new_v4();
        DesktopQuitJournal::claim(&database, Some(epoch))
            .await
            .unwrap()
            .advance()
            .await
            .unwrap();
        let journal = Journal::for_boot(&database, boot.clone()).unwrap();
        let launcher = root.path().join("fixture-launcher");
        fs::write(&launcher, FIXTURE_LAUNCHER).unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
        let foreground = orphan_run(&root.path().join("foreground"), &launcher, &journal).await;
        let background = orphan_run(&root.path().join("background"), &launcher, &journal).await;
        let mut witness = Command::new("python3")
            .args(["-c", WORKERS])
            .arg(root.path())
            .arg("witness")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let witness_pid = witness.id().unwrap();
        let witness_count = root.path().join("witness");
        await_counter(&witness_count, 1).await;
        drop(original_service);

        let slots = root.path().join("desktop-recovery");
        let quit = slots.join(format!("{epoch}.quit"));
        fs::rename(slots.join(format!("{epoch}.armed")), &quit).unwrap();
        let stale_id = Uuid::new_v4();
        let stale_path = file(&journal.directory, stale_id);
        write_atomic_private(&stale_path, &foreground.proof).unwrap();
        Journal::for_boot(&database, BootIdentity::fixture())
            .unwrap()
            .finish(stale_id)
            .await
            .unwrap();
        assert!(!stale_path.exists());

        let mut wrong: serde_json::Value = serde_json::from_str(&foreground.proof).unwrap();
        wrong["anchor"]["generation"] = serde_json::json!("other generation");
        write_atomic_private(&foreground.record, &wrong.to_string()).unwrap();
        let clean = || {
            finish_cold_quit(&database, epoch, |locked_database, key| {
                let boot = boot.clone();
                async move {
                    assert!(crate::startup_lock::acquire_db_lock(&locked_database).is_err());
                    Journal::reap_for_quit(&locked_database, &key, std::future::ready(Ok(boot)))
                        .await
                }
            })
        };
        let refusal = clean().await.unwrap_err();
        assert!(refusal.to_string().contains("cannot verify ownership"));
        assert!(quit.is_file() && foreground.record.is_file());
        await_counter(
            &foreground.directory.join("owned"),
            foreground.writes_before_quit + 2,
        )
        .await;

        write_atomic_private(&foreground.record, &foreground.proof).unwrap();
        clean().await.unwrap();
        // This is the successful quit acknowledgement. No service is started
        // to dispatch or stop work after this point.
        let runs = [foreground, background];
        let mut settled = Vec::new();
        for run in &runs {
            assert!(!run.record.exists());
            assert!(!owned_process_is_live(run.worker, run.sid).unwrap());
            assert!(!owned_process_is_live(run.anchor, run.sid).unwrap());
            let owned = run.directory.join("owned");
            let detached = run.directory.join("detached");
            settled.push((
                fs::read(&owned).unwrap(),
                await_counter(&detached, 1).await.len(),
            ));
        }
        assert!(
            quit.is_file(),
            "normal startup must still consume the quit later"
        );
        let witness_ticks = await_counter(&witness_count, 1).await.len();
        await_counter(&witness_count, witness_ticks + 4).await;
        for (run, (owned, detached_ticks)) in runs.iter().zip(settled) {
            await_counter(&run.directory.join("detached"), detached_ticks + 4).await;
            assert_eq!(fs::read(run.directory.join("owned")).unwrap(), owned);
            assert!(owned_process_is_live(run.detached, run.detached).unwrap());
            fs::File::create(run.directory.join("finish")).unwrap();
        }
        assert!(owned_process_is_live(witness_pid, witness_pid).unwrap());
        fs::File::create(root.path().join("finish")).unwrap();
        assert!(witness.wait().await.unwrap().success());
        tokio::time::timeout(Duration::from_secs(2), async {
            for run in &runs {
                while owned_process_is_live(run.detached, run.detached).unwrap() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        })
        .await
        .unwrap();
    }
}
