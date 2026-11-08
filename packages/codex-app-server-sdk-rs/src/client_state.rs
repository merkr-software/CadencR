use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::client_io::{PendingMap, StderrTail};
use crate::event_queue::EventHub;
use crate::types::{AppServerClientInfo, AppServerExit};

pub(crate) struct Inner {
    pub(crate) stdin: Mutex<ChildStdin>,
    pub(crate) next_id: AtomicU64,
    pub(crate) pid: Option<u32>,
    pub(crate) pending: Arc<StdMutex<PendingMap>>,
    pub(crate) events: EventHub,
    pub(crate) reader_task: StdMutex<Option<JoinHandle<()>>>,
    pub(crate) stderr_task: StdMutex<Option<JoinHandle<()>>>,
    pub(crate) reaper_task: StdMutex<Option<JoinHandle<()>>>,
    pub(crate) kill_tx: StdMutex<Option<oneshot::Sender<()>>>,
    pub(crate) stderr_tail: Arc<StdMutex<StderrTail>>,
    pub(crate) exit: Arc<StdMutex<Option<AppServerExit>>>,
    pub(crate) client_info: AppServerClientInfo,
    pub(crate) request_timeout: Duration,
}

pub(crate) struct PendingRequestGuard {
    pub(crate) pending: Arc<StdMutex<PendingMap>>,
    pub(crate) id: u64,
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Ok(mut kill_tx) = self.kill_tx.lock() {
            if let Some(tx) = kill_tx.take() {
                let _ = tx.send(());
            }
        }
    }
}
