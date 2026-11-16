//! A staged update: a verified revision named by `pending.json` beside
//! `active.json`, kept until the user reviews what it may now run. The
//! active revision keeps serving (and running) meanwhile.
use super::{
    invalid, owner, pointer_directory, retention, validate_pointer, RevisionLease, ACTIVE,
};
use crate::error::AppError;
use axum::http::StatusCode;
use std::path::{Path, PathBuf};

pub(super) const POINTER: &str = "pending.json";

/// The staged revision's tab folder, if an update awaits review. A pointer
/// naming the active revision — a promotion interrupted between its two
/// writes — stages nothing; the next collection removes it.
pub fn pending_directory(root: &Path, id: &str) -> Result<Option<PathBuf>, AppError> {
    let staged = pointer_directory(root, id, POINTER)?;
    if staged.is_some() && staged == super::directory(root, id)? {
        return Ok(None);
    }
    Ok(staged)
}

/// Remove a pointer that names the active revision (see
/// [`pending_directory`]). Call it with the owner's lock held.
pub(super) fn clear_if_active(root: &Path, id: &str) -> Result<(), AppError> {
    if pending_directory(root, id)?.is_none() && pointer_directory(root, id, POINTER)?.is_some() {
        clear(&owner(root, id)?)?;
    }
    Ok(())
}

/// Pin the staged revision, like [`super::lease`] pins the active one.
pub fn lease_pending(root: &Path, id: &str) -> Result<Option<RevisionLease>, AppError> {
    retention::lease_selected(root, id, pending_directory)
}

/// Make the staged `revision` the active one. 409
/// `MANAGED_TAB_UPDATE_CHANGED` when another update replaced or discarded it
/// since it was reviewed. The previous revision stays while a lease (a
/// running backend, an open page) holds it.
pub fn promote_pending(root: &Path, id: &str, revision: &str) -> Result<(), AppError> {
    let cell = retention::owner_state(root, id)?;
    let state = cell.lock().map_err(invalid)?;
    let owned = owner(root, id)?;
    let staged = pending_directory(root, id)?;
    if staged.as_deref() != Some(owned.join(revision).join(id).as_path()) {
        return Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_TAB_UPDATE_CHANGED",
            format!("the update of `{id}` changed since it was shown; review it again"),
        ));
    }
    validate_pointer(&owned.join(ACTIVE))?;
    crate::shared::atomic_file::write_atomic_private(
        &owned.join(ACTIVE),
        &serde_json::to_string(revision).map_err(invalid)?,
    )?;
    std::fs::remove_file(owned.join(POINTER)).map_err(invalid)?;
    retention::collect(root, id, &state)
}

/// Drop the staged update; its revision is reclaimed once unleased. 404
/// `MANAGED_TAB_UPDATE_NOT_FOUND` when none is staged.
pub fn discard_pending(root: &Path, id: &str) -> Result<(), AppError> {
    let cell = retention::owner_state(root, id)?;
    let state = cell.lock().map_err(invalid)?;
    clear_if_active(root, id)?;
    if pending_directory(root, id)?.is_none() {
        return Err(AppError::coded(
            StatusCode::NOT_FOUND,
            "MANAGED_TAB_UPDATE_NOT_FOUND",
            format!("no update of `{id}` awaits review"),
        ));
    }
    std::fs::remove_file(owner(root, id)?.join(POINTER)).map_err(invalid)?;
    retention::collect(root, id, &state)
}

/// Remove a pointer file after checking it holds a revision digest, never
/// an unknown file at that path. Absent is fine.
pub(super) fn clear(owner: &Path) -> Result<(), AppError> {
    let pointer = owner.join(POINTER);
    match pointer.symlink_metadata() {
        Ok(_) => {
            validate_pointer(&pointer)?;
            std::fs::remove_file(pointer).map_err(invalid)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(invalid(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::fixture_revision;
    use super::super::{commit, commit_revision, directory, Activation};
    use super::*;

    #[test]
    fn a_pending_pointer_to_the_active_revision_stages_nothing_and_is_cleaned() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let (first, archive, files, _) = fixture_revision(&temp.path().join("v0"), 0);
        commit(&root, &first, &archive, &files).unwrap();
        let (second, archive, files, _) = fixture_revision(&temp.path().join("v1"), 1);
        commit_revision()
            .root(&root)
            .receipt(&second)
            .archive(&archive)
            .files(&files)
            .activation(Activation::Stage)
            .call()
            .unwrap();
        let staged = pending_directory(&root, "graph").unwrap().unwrap();
        // A promotion that crashed after moving `active.json`.
        let owned = owner(&root, "graph").unwrap();
        std::fs::copy(owned.join(POINTER), owned.join(ACTIVE)).unwrap();
        assert_eq!(directory(&root, "graph").unwrap(), Some(staged));
        assert!(pending_directory(&root, "graph").unwrap().is_none());
        assert!(lease_pending(&root, "graph").unwrap().is_none());
        assert!(owned.join(POINTER).exists(), "only read so far");
        let cell = retention::owner_state(&root, "graph").unwrap();
        let state = cell.lock().unwrap();
        retention::collect(&root, "graph", &state).unwrap();
        assert!(!owned.join(POINTER).exists());
        assert!(directory(&root, "graph").unwrap().is_some());
    }
}
