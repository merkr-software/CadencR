use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use tokio::sync::{watch, Notify};

use anyhow::Context;
use cli_discovery::{AnchorRecord, ChildSession, ChildSessionObserver};

use super::journal::{Journal, Lease};

static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();

#[derive(Clone, Debug)]
enum Drain {
    Pending,
    Failed(String),
    Unverifiable(String),
    Done,
}

#[derive(Clone)]
struct ProcessTree {
    registry: Arc<Registry>,
    state: Arc<DrainState>,
}

struct DrainState {
    status: watch::Sender<Drain>,
    retry: Notify,
    lease: OnceLock<Lease>,
}

struct Registry {
    processes: Mutex<HashMap<u32, Arc<DrainState>>>,
    journal: Journal,
    launcher: PathBuf,
}

impl Registry {
    fn trees(&self) -> MutexGuard<'_, HashMap<u32, Arc<DrainState>>> {
        self.processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn tree(self: &Arc<Registry>) -> ProcessTree {
        ProcessTree {
            registry: self.clone(),
            state: Arc::new(DrainState {
                status: watch::Sender::new(Drain::Pending),
                retry: Notify::new(),
                lease: OnceLock::new(),
            }),
        }
    }
}

pub(super) async fn recover(database: &Path, database_key: &str) -> anyhow::Result<()> {
    let journal = Journal::open(database, database_key).await?;
    journal.reap().await.context("Cadencr could not verify that the previous service's agent processes stopped. Try starting it again.")?;
    let launcher = std::env::current_exe().context("could not locate the provider launcher")?;
    REGISTRY.get_or_init(|| {
        Arc::new(Registry {
            processes: Mutex::default(),
            journal,
            launcher,
        })
    });
    Ok(())
}

pub(super) fn owns(pid: u32) -> bool {
    REGISTRY
        .get()
        .is_some_and(|registry| registry.trees().contains_key(&pid))
}

pub(super) fn anchor_of(pid: u32) -> Option<i32> {
    let registry = REGISTRY.get()?;
    registry
        .trees()
        .get(&pid)?
        .lease
        .get()
        .map(|lease| lease.anchor.anchor_pid())
}

pub(super) fn new_session() -> Option<ChildSession> {
    let registry = REGISTRY.get()?;
    Some(ChildSession::with_anchor(
        Arc::new(registry.tree()),
        registry.launcher.clone(),
    ))
}

impl ChildSessionObserver for ProcessTree {
    fn started(&self, pid: u32) {
        self.registry.trees().insert(pid, self.state.clone());
    }

    fn before_reap(&self, pid: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(self.finish(pid))
    }

    fn record_anchor(&self, leader: u32, anchor: u32) -> AnchorRecord<'_> {
        Box::pin(async move {
            let lease = self
                .registry
                .journal
                .record(leader, anchor)
                .await
                .map_err(std::io::Error::other)?;
            self.state.lease.set(lease).map_err(|_| {
                std::io::Error::other("a process session launch was already recorded")
            })?;
            self.started(leader);
            Ok(())
        })
    }

    fn launch_failed(&self) {
        if let Some(lease) = self.state.lease.get() {
            self.finish_in_background(lease.anchor.leader());
        }
    }

    fn observation_failed(&self, pid: u32, error: &std::io::Error) {
        tracing::error!(pid, %error, "could not observe the provider's direct child");
        if self.state.lease.get().is_some() {
            self.finish_in_background(pid);
        } else {
            self.state
                .status
                .send_replace(Drain::Unverifiable(error.to_string()));
        }
    }
}

impl ProcessTree {
    fn finish_in_background(&self, pid: u32) {
        let tree = self.clone();
        tokio::spawn(async move { tree.finish(pid).await });
    }

    async fn finish(&self, pid: u32) {
        let Some(lease) = self.state.lease.get() else {
            self.observation_failed(
                pid,
                &std::io::Error::other("missing process session record"),
            );
            return;
        };
        self.drain(pid, |_| self.registry.journal.finish(lease.id))
            .await;
    }

    async fn drain<F>(&self, pid: u32, mut stop: impl FnMut(u32) -> F)
    where
        F: Future<Output = anyhow::Result<()>>,
    {
        loop {
            match stop(pid).await {
                Ok(()) => {
                    self.state.status.send_replace(Drain::Done);
                    let mut trees = self.registry.trees();
                    if trees
                        .get(&pid)
                        .is_some_and(|owner| Arc::ptr_eq(owner, &self.state))
                    {
                        trees.remove(&pid);
                    }
                    return;
                }
                Err(error) => {
                    tracing::error!(pid, %error, "could not confirm that a provider's processes stopped");
                    self.state
                        .status
                        .send_replace(Drain::Failed(error.to_string()));
                    // Retain the anchored session and its durable proof
                    // while waiting for the user to retry the quit.
                    self.state.retry.notified().await;
                }
            }
        }
    }
}

pub(super) fn retry_failed_drains() {
    if let Some(registry) = REGISTRY.get() {
        retry_registry(registry);
    }
}

fn retry_registry(registry: &Registry) {
    for tree in registry.trees().values() {
        if tree.status.send_if_modified(|status| {
            if matches!(status, Drain::Failed(_)) {
                *status = Drain::Pending;
                return true;
            }
            false
        }) {
            tree.retry.notify_one();
        }
    }
}

pub(super) async fn confirm_stopped() -> anyhow::Result<()> {
    if let Some(registry) = REGISTRY.get() {
        confirm_registry(registry).await?;
    }
    Ok(())
}

async fn confirm_registry(registry: &Registry) -> anyhow::Result<()> {
    let watchers: Vec<_> = registry
        .trees()
        .iter()
        .map(|(&pid, tree)| (pid, tree.status.subscribe()))
        .collect();
    tokio::time::timeout(Duration::from_secs(5), futures::future::try_join_all(
        watchers.into_iter().map(|(pid, mut state)| async move {
            loop {
                match state.borrow_and_update().clone() {
                    Drain::Pending => {}
                    Drain::Done => return Ok(()),
                    Drain::Failed(error) => anyhow::bail!("could not verify that the work from provider process {pid} stopped: {error}"),
                    Drain::Unverifiable(error) => anyhow::bail!("could not verify provider process {pid} after losing its ownership proof: {error}"),
                }
                state.changed().await?;
            }
        })
    )).await.map_err(|_| anyhow::anyhow!("Timed out waiting to verify that the provider processes stopped"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_failed_provider_process_drain_keeps_the_same_identity_until_retry() {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("db/test.sqlite");
        std::fs::create_dir(db.parent().unwrap()).unwrap();
        std::fs::File::create(&db).unwrap();
        let registry = Arc::new(Registry {
            processes: Mutex::default(),
            journal: Journal::for_boot(&db, crate::shared::process_table::BootIdentity::fixture())
                .unwrap(),
            launcher: std::env::current_exe().unwrap(),
        });
        let tree = registry.tree();
        let pid = 101;
        tree.started(pid);
        let mut tries = 0;
        let mut drain = std::pin::pin!(tree.drain(pid, |id| {
            assert_eq!(id, pid);
            tries += 1;
            std::future::ready(if tries == 1 {
                Err(
                    std::io::Error::new(std::io::ErrorKind::PermissionDenied, "fixture refused")
                        .into(),
                )
            } else {
                Ok(())
            })
        }));
        assert!(futures::poll!(&mut drain).is_pending());
        assert!(confirm_registry(&registry)
            .await
            .unwrap_err()
            .to_string()
            .contains("fixture refused"));
        assert!(registry.trees().contains_key(&pid));
        retry_registry(&registry);
        drain.await;
        confirm_registry(&registry).await.unwrap();
        assert!(registry.trees().is_empty());
    }
}
