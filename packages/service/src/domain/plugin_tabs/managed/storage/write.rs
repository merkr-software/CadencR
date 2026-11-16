//! Committing a verified revision: write it once into a private staging
//! folder, publish it with one rename, then move a pointer.
use super::{
    backend, check_directory, filesystem, ids, invalid, io, owner, pending, retention, revision_id,
    secure, validate_pointer, write_file, Activation, BackendPayload, Receipt, ACTIVE, LIMIT,
    MAX_ACTIVE_TABS, RECEIPT, WEB_ARCHIVE,
};
use crate::error::AppError;
use std::{collections::BTreeMap, path::Path};

/// One verified revision's bytes, as committed.
struct RevisionBytes<'a> {
    receipt: &'a Receipt,
    archive: &'a [u8],
    files: &'a BTreeMap<String, Vec<u8>>,
    backend: Option<&'a BackendPayload<'a>>,
}

/// Store one verified revision (reusing identical retained bytes) and point
/// `active.json` — or, for [`Activation::Stage`], `pending.json` — at it.
#[bon::builder]
pub fn commit_revision(
    root: &Path,
    receipt: &Receipt,
    archive: &[u8],
    files: &BTreeMap<String, Vec<u8>>,
    backend: Option<BackendPayload<'_>>,
    activation: Activation,
) -> Result<(), AppError> {
    if archive.len() > LIMIT {
        return Err(invalid("tab archive exceeds 32 MiB"));
    }
    if backend.is_some() != receipt.platform.is_some() {
        return Err(invalid("tab receipt platform and backend disagree"));
    }
    let owner = owner(root, &receipt.id)?;
    let active = ids(root)?;
    if activation == Activation::Stage && !active.contains(&receipt.id) {
        return Err(invalid("only an installed tab can stage an update"));
    }
    if !active.contains(&receipt.id) && active.len() >= MAX_ACTIVE_TABS {
        return Err(invalid(
            "at most 128 marketplace tabs can be installed at once",
        ));
    }
    let cell = retention::admit_owner(root, &receipt.id)?;
    let state = cell.lock().map_err(invalid)?;
    secure(root, &owner)?;
    let bytes = RevisionBytes {
        receipt,
        archive,
        files,
        backend: backend.as_ref(),
    };
    let sha = revision_id(
        &io::digest(archive),
        backend
            .as_ref()
            .map(|backend| backend.archive_sha256.as_str()),
    );
    let destination = owner.join(&sha);
    if destination.try_exists().map_err(invalid)? {
        check_retained(root, &destination, &bytes)?;
        // Store the newly authenticated catalog proof even when reusing identical bytes.
        write_receipt(&destination, receipt)?;
    } else {
        retention::prepare(root, &receipt.id, &state)?;
        stage(root, &destination, &bytes)?;
    }
    point(root, &owner, &receipt.id, &sha, activation)
}

/// Point `active.json` (or, to stage, `pending.json`) at revision `sha`.
fn point(
    root: &Path,
    owner: &Path,
    id: &str,
    sha: &str,
    activation: Activation,
) -> Result<(), AppError> {
    let pointer = serde_json::to_string(sha).map_err(invalid)?;
    // Also refuses an unknown file at `active.json`: it is never replaced.
    let current = super::directory(root, id)?;
    if activation == Activation::Activate
        || current.as_deref() == Some(owner.join(sha).join(id).as_path())
    {
        crate::shared::atomic_file::write_atomic_private(&owner.join(ACTIVE), &pointer)?;
        // A newer revision supersedes an update still awaiting review.
        return pending::clear(owner);
    }
    if owner.join(pending::POINTER).symlink_metadata().is_ok() {
        validate_pointer(&owner.join(pending::POINTER))?;
    }
    crate::shared::atomic_file::write_atomic_private(&owner.join(pending::POINTER), &pointer)
}

/// Write a new revision into a private staging folder, seal it, then publish
/// it at `destination` with one rename.
fn stage(root: &Path, destination: &Path, bytes: &RevisionBytes<'_>) -> Result<(), AppError> {
    let owner = destination
        .parent()
        .ok_or_else(|| invalid("revision owner missing"))?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".stage-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    // Do not let TempDir recursively delete an interrupted/modified tree:
    // partial stages stay bounded by retention admission and need review.
    let staging = builder.tempdir_in(owner).map_err(invalid)?.keep();
    let payload = staging.join(&bytes.receipt.id);
    secure(root, &payload)?;
    for (name, content) in bytes.files {
        let path = payload.join(name);
        secure(
            root,
            path.parent()
                .ok_or_else(|| invalid("asset parent missing"))?,
        )?;
        write_file(&path, content)?;
    }
    write_file(&staging.join(WEB_ARCHIVE), bytes.archive)?;
    if let Some(backend) = bytes.backend {
        backend::write(root, &staging, &payload, backend)?;
    }
    crate::shared::atomic_file::write_atomic_private(
        &staging.join(RECEIPT),
        &serde_json::to_string(bytes.receipt).map_err(invalid)?,
    )?;
    filesystem::seal_contents(&staging)?;
    std::fs::rename(&staging, destination).map_err(invalid)?;
    filesystem::seal_directory(destination)
}

/// Rewrite the receipt of the published revision at `destination`, sealed
/// read-only around it. A revision stored before sealing (still writable)
/// is sealed whole.
fn write_receipt(destination: &Path, receipt: &Receipt) -> Result<(), AppError> {
    let legacy = !filesystem::is_sealed_directory(&destination.join(&receipt.id))?;
    filesystem::unseal_directory(destination)?;
    let path = destination.join(RECEIPT);
    crate::shared::atomic_file::write_atomic_private(
        &path,
        &serde_json::to_string(receipt).map_err(invalid)?,
    )?;
    if legacy {
        filesystem::seal_contents(destination)?;
    } else {
        filesystem::seal_file(&path)?;
    }
    filesystem::seal_directory(destination)
}

/// A retained revision at `destination` holds exactly the requested bytes,
/// and its receipt is ours to replace.
fn check_retained(
    root: &Path,
    destination: &Path,
    bytes: &RevisionBytes<'_>,
) -> Result<(), AppError> {
    let receipt = bytes.receipt;
    let payload = destination.join(&receipt.id);
    check_directory(root, &payload)?;
    if io::regular(&destination.join(WEB_ARCHIVE), LIMIT)? != bytes.archive {
        return Err(invalid(
            "retained tab archive differs from requested revision",
        ));
    }
    for (name, content) in bytes.files {
        if io::regular(&payload.join(name), LIMIT)? != *content {
            return Err(invalid("retained tab payload changed"));
        }
    }
    if let Some(backend) = bytes.backend {
        backend::matches(destination, &payload, backend)?;
    }
    // Only replace managed JSON, never an unknown file occupying a control path.
    let retained: Receipt =
        serde_json::from_slice(&io::regular(&destination.join(RECEIPT), LIMIT + 64 * 1024)?)
            .map_err(invalid)?;
    if retained.id != receipt.id
        || retained.version != receipt.version
        || retained.platform != receipt.platform
    {
        return Err(invalid("retained tab receipt identity mismatch"));
    }
    Ok(())
}
