//! Reserve owner directories atomically; expensive reclamation never holds admission.
use super::{
    coordination::{self, OwnerState},
    *,
};

pub(in crate::domain::plugin_tabs::managed::storage) fn admit_owner(
    root: &Path,
    id: &str,
) -> Result<OwnerState, AppError> {
    super::super::secure(root, root)?;
    let cell = coordination::owner_state(root, id)?;
    if reserve(root, id)? {
        return Ok(cell);
    }
    // A sweep may decompress archives, so it is deliberately outside the root
    // reservation lock. Busy/live owners are skipped rather than delaying reads.
    sweep(root)?;
    if !reserve(root, id)? {
        return Err(full());
    }
    Ok(cell)
}
fn reserve(root: &Path, id: &str) -> Result<bool, AppError> {
    let _guard = coordination::admission()?;
    let owned = owner(root, id)?;
    if owned.symlink_metadata().is_ok() {
        check_directory(root, &owned)?;
        return Ok(true);
    }
    if count(root, MAX_OWNERS)? >= MAX_OWNERS {
        return Ok(false);
    }
    super::super::secure(root, &owned)?;
    Ok(true)
}
fn sweep(root: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(root).map_err(invalid)? {
        let entry = entry.map_err(invalid)?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if owner(root, &id).is_err() || check_directory(root, &entry.path()).is_err() {
            continue;
        }
        let cell = coordination::owner_state(root, &id)?;
        if Arc::strong_count(&cell) > 1 {
            continue;
        }
        let state = match cell.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::WouldBlock) => continue,
            Err(error) => return Err(invalid(error)),
        };
        match entry.path().join(super::ACTIVE).symlink_metadata() {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(invalid(error)),
        }
        collect(root, &id, &state)?;
        remove_empty_owner(root, &id, &cell)?;
    }
    Ok(())
}
pub(in crate::domain::plugin_tabs::managed::storage) fn remove_empty_owner(
    root: &Path,
    id: &str,
    cell: &OwnerState,
) -> Result<(), AppError> {
    let _guard = coordination::admission()?;
    // A pending writer owns this same Arc before reserving its directory. Do not
    // remove its reservation and allow a later recreation to exceed root quota.
    if Arc::strong_count(cell) == 1 && count(&owner(root, id)?, 1)? == 0 {
        std::fs::remove_dir(owner(root, id)?).map_err(invalid)?;
    }
    Ok(())
}
fn count(path: &Path, limit: usize) -> Result<usize, AppError> {
    std::fs::read_dir(path)
        .map_err(invalid)?
        .take(limit)
        .try_fold(0, |count, entry| {
            entry.map_err(invalid)?;
            Ok(count + 1)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_direct_admission_reserves_at_most_128_owner_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        super::super::super::secure(&root, &root).unwrap();
        for number in 0..MAX_OWNERS - 1 {
            let owned = owner(&root, &format!("retained-{number}")).unwrap();
            super::super::super::secure(&root, &owned).unwrap();
            // Unknown data prevents orphan cleanup from manufacturing free slots.
            std::fs::write(owned.join("notes.txt"), "preserve").unwrap();
        }
        let barrier = Arc::new(std::sync::Barrier::new(8));
        std::thread::scope(|scope| {
            let results: Vec<_> = (0..8)
                .map(|number| {
                    let (root, barrier) = (&root, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        admit_owner(root, &format!("new-{number}"))
                    })
                })
                .collect();
            let successful: Vec<_> = results
                .into_iter()
                .map(|task| task.join().unwrap())
                .filter_map(Result::ok)
                .collect();
            assert_eq!(successful.len(), 1);
            assert_eq!(count(&root, MAX_OWNERS + 1).unwrap(), MAX_OWNERS);
        });
    }
}
