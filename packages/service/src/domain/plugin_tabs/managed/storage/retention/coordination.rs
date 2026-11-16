//! Owner mutexes outlive every lease; the registry itself retains only weak refs.
use super::*;

pub(in crate::domain::plugin_tabs::managed::storage) type OwnerState = Arc<Mutex<State>>;
static OWNERS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<State>>>>> = OnceLock::new();
static ADMISSION: Mutex<()> = Mutex::new(());

pub(super) fn admission() -> Result<MutexGuard<'static, ()>, AppError> {
    ADMISSION.lock().map_err(invalid)
}
pub(in crate::domain::plugin_tabs::managed::storage) fn owner_state(
    root: &Path,
    id: &str,
) -> Result<OwnerState, AppError> {
    let owned = owner(&root.canonicalize().map_err(invalid)?, id)?;
    let mut owners = OWNERS.get_or_init(Mutex::default).lock().map_err(invalid)?;
    owners.retain(|_, state| state.strong_count() > 0);
    if let Some(state) = owners.get(&owned).and_then(Weak::upgrade) {
        return Ok(state);
    }
    let state = Arc::new(Mutex::new(State::default()));
    owners.insert(owned, Arc::downgrade(&state));
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unused_owner_states_are_pruned_but_live_lease_state_is_shared() {
        let temp = tempfile::tempdir().unwrap();
        for number in 0..256 {
            drop(owner_state(temp.path(), &format!("tab-{number}")).unwrap());
        }
        let held = owner_state(temp.path(), "held").unwrap();
        assert!(Arc::ptr_eq(
            &held,
            &owner_state(temp.path(), "held").unwrap()
        ));
        let canonical = temp.path().canonicalize().unwrap();
        let owners = OWNERS.get().unwrap().lock().unwrap();
        assert_eq!(
            owners
                .keys()
                .filter(|path| path.starts_with(&canonical))
                .count(),
            1
        );
    }

    #[test]
    fn owner_a_mutation_does_not_block_owner_b_read_and_same_owner_waits() {
        use crate::domain::plugin_tabs::managed::storage::{self, fixtures::fixture_for};
        use std::sync::mpsc;
        use std::time::Duration;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let mut proofs = Vec::new();
        for id in ["owner-a", "owner-b"] {
            let (receipt, archive, files, trust) =
                fixture_for().root(&temp.path().join(id)).id(id).call();
            storage::commit(&root, &receipt, &archive, &files).unwrap();
            proofs.push(trust);
        }
        let paused_owner = owner_state(&root, "owner-a").unwrap();
        let paused_write = paused_owner.lock().unwrap();
        std::thread::scope(|scope| {
            let (same_tx, same_rx) = mpsc::channel();
            let (started_tx, started_rx) = mpsc::channel();
            let same_root = &root;
            scope.spawn(move || {
                started_tx.send(()).unwrap();
                let selected = storage::lease(same_root, "owner-a").unwrap().unwrap();
                same_tx.send(selected).unwrap();
            });
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (other_tx, other_rx) = mpsc::channel();
            let (other_root, trust) = (&root, &proofs[1]);
            scope.spawn(move || {
                let selected = storage::lease(other_root, "owner-b").unwrap().unwrap();
                let trusted = storage::read_trusted_directory(
                    other_root,
                    "owner-b",
                    selected.directory(),
                    trust,
                )
                .unwrap();
                other_tx.send(trusted.revision.manifest.id).unwrap();
            });
            // Release A even on timeout so a regression fails instead of hanging
            // while scoped-thread cleanup waits for the same-owner reader.
            let other = other_rx.recv_timeout(Duration::from_secs(5));
            let same_waited = matches!(same_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
            drop(paused_write);
            assert_eq!(other.unwrap(), "owner-b");
            assert!(same_waited);
            let selected = same_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            storage::deactivate(&root, "owner-a").unwrap();
            assert!(selected.directory().join("tab.json").exists());
        });
    }

    #[test]
    fn lease_keeps_owner_state_alive_after_the_mutator_and_registry_handles_drop() {
        use crate::domain::plugin_tabs::managed::storage::{self, fixtures::fixture_for};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let (receipt, archive, files, _) = fixture_for().root(&temp.path().join("fixture")).call();
        storage::commit(&root, &receipt, &archive, &files).unwrap();
        let selected = storage::lease(&root, "graph").unwrap().unwrap();
        let original = owner_state(&root, "graph").unwrap();
        let weak = Arc::downgrade(&original);
        drop(original);
        assert!(weak.upgrade().is_some());
        assert!(Arc::ptr_eq(
            &weak.upgrade().unwrap(),
            &owner_state(&root, "graph").unwrap()
        ));
        storage::deactivate(&root, "graph").unwrap();
        assert!(selected.directory().exists());
        drop(selected);
        assert!(weak.upgrade().is_none());
    }
}
