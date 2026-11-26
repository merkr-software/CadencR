use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;

use cli_discovery::{wait_for_child, ChildSession, ChildSessionObserver};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Notify};

use super::*;

#[test]
fn a_partial_process_snapshot_breaks_the_empty_session_proof() {
    let mut previous = None;
    let mut complete = Snapshot::default();
    let mut incomplete = Snapshot {
        incomplete: true,
        ..Snapshot::default()
    };
    assert!(!confirmed_empty(&mut previous, &mut complete));
    assert!(!confirmed_empty(&mut previous, &mut incomplete));
    assert!(!confirmed_empty(&mut previous, &mut complete));
    assert!(confirmed_empty(&mut previous, &mut complete));
}

#[test]
fn a_zombie_new_to_each_snapshot_can_be_a_handoff_to_an_unlisted_child() {
    let mut previous = None;
    for (pid, expected) in [(101, false), (102, false), (103, false), (103, true)] {
        let mut snapshot = Snapshot {
            exited: HashSet::from([pid]),
            ..Snapshot::default()
        };
        let confirmed = confirmed_empty(&mut previous, &mut snapshot);
        // The last PID is stable for a second complete enumeration.
        assert_eq!(confirmed, expected);
    }
}

struct ObserveExit {
    entered: tokio::sync::Mutex<Option<oneshot::Sender<()>>>,
    release: Notify,
}

impl ChildSessionObserver for ObserveExit {
    fn started(&self, _: u32) {}

    fn before_reap(&self, pid: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            self.entered.lock().await.take().unwrap().send(()).unwrap();
            self.release.notified().await;
            stop_pinned_session(pid).await.unwrap();
        })
    }
}

/// Distinct process groups in one session, a worker born during the drain,
/// and a detached process deliberately outside that session's ownership.
#[tokio::test]
async fn an_already_exited_leader_pins_cooperative_stubborn_and_late_workers_only() {
    let dir = tempfile::tempdir().unwrap();
    let fake = r#"
import json, os, signal, sys, time
from pathlib import Path
root = Path(sys.argv[1])

def worker(kind):
    ready, ack = os.pipe()
    pid = os.fork()
    if pid:
        os.close(ack)
        assert os.read(ready, 1) == b'!'
        os.close(ready)
        return pid
    os.close(ready)
    if kind == 'detached':
        os.setsid()
    else:
        os.setpgid(0, 0)
    def terminate(signo, frame):
        if os.fork() == 0:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            (root / 'late').write_text(str(os.getpid()))
            time.sleep(9)
            os._exit(0)
        (root / 'cooperated').touch()
        os._exit(0)
    signal.signal(signal.SIGTERM, terminate if kind == 'cooperative' else signal.SIG_IGN)
    os.close(0)
    os.close(1)
    os.close(2)
    os.write(ack, b'!')
    os.close(ack)
    until = time.monotonic() + 9
    while time.monotonic() < until and not (root / 'fixture-exit').exists():
        time.sleep(0.025)
    os._exit(0)

print(json.dumps([worker('cooperative'), worker('stubborn'), worker('detached')]), flush=True)
sys.stdin.readline()
"#;
    let (entered_tx, entered_rx) = oneshot::channel();
    let observer = Arc::new(ObserveExit {
        entered: tokio::sync::Mutex::new(Some(entered_tx)),
        release: Notify::new(),
    });
    let mut command = tokio::process::Command::new("python3");
    command
        .arg("-c")
        .arg(fake)
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    let session = ChildSession::new(observer.clone());
    let mut leader = session.spawn(command).await.unwrap();
    let sid = leader.id().unwrap() as i32;
    let mut stdin = leader.stdin.take().unwrap();
    let mut stdout = BufReader::new(leader.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let [cooperative, stubborn, detached]: [i32; 3] = serde_json::from_str(&line).unwrap();
    let detached_identity = super::super::start_time(detached as u32).await.unwrap();
    stdin.write_all(b"exit\n").await.unwrap();
    let wait = tokio::spawn(async move { wait_for_child(&mut leader, Some(&session)).await });
    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(matches_session(cooperative, sid).unwrap());
    assert!(matches_session(stubborn, sid).unwrap());
    assert!(!matches_session(detached, sid).unwrap());
    observer.release.notify_one();
    assert!(tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .success());
    assert!(dir.path().join("cooperated").exists());
    let late: i32 = std::fs::read_to_string(dir.path().join("late"))
        .unwrap()
        .parse()
        .unwrap();
    for gone in [cooperative, stubborn, late] {
        assert!(platform::Target::open(gone, sid).unwrap().is_none());
    }
    assert_eq!(
        super::super::start_time(detached as u32).await.as_deref(),
        Some(detached_identity.as_str())
    );
    std::fs::File::create(dir.path().join("fixture-exit")).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while platform::Target::open(detached, detached)
            .unwrap()
            .is_some()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
