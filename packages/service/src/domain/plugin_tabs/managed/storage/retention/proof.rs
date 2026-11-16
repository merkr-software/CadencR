//! Exact-tree proof for deletion; unrecognized content is never disposable.
use super::*;

/// What one recognized file must hold. The backend archive and executable
/// are compared by signed digest, streamed: too large to keep in memory.
enum Expected {
    Bytes(Vec<u8>),
    Digest {
        sha256: String,
        limit: u64,
        executable: bool,
    },
}
impl Expected {
    fn holds(&self, path: &Path) -> Result<bool, AppError> {
        Ok(match self {
            Self::Bytes(bytes) => io::regular(path, LIMIT + 64 * 1024)? == *bytes,
            Self::Digest {
                sha256,
                limit,
                executable,
            } => {
                super::super::filesystem::hash_private_file(path, *limit, *executable)?.0 == *sha256
            }
        })
    }
}
pub(super) struct Plan {
    files: BTreeMap<PathBuf, Expected>,
    directories: BTreeSet<PathBuf>,
}
pub(super) fn recognized(root: &Path, id: &str, revision: &Path) -> Result<Plan, AppError> {
    check_directory(root, revision)?;
    let receipt_bytes = io::regular(&revision.join(RECEIPT), LIMIT + 64 * 1024)?;
    let receipt: Receipt = serde_json::from_slice(&receipt_bytes).map_err(invalid)?;
    if receipt.id != id {
        return Err(invalid("retained tab receipt identity mismatch"));
    }
    let archive = io::regular(&revision.join(WEB_ARCHIVE), LIMIT)?;
    let sha = io::digest(&archive);
    // Deletion proves historical bytes, not whether they can run on this host.
    // In particular an app upgrade must not make max_app_version revisions immortal.
    let members = cadencr_registry_core::catalog_members(&receipt.index.signed.packages);
    let mut matches = members.filter(|entry| {
        entry["kind"] == "tab"
            && entry["package"]["tab"]["id"] == id
            && entry["package"]["tab"]["version"] == receipt.version
    });
    let package = &matches
        .next()
        .ok_or_else(|| invalid("retained tab receipt package missing"))?["package"];
    if matches.next().is_some() {
        return Err(invalid("retained tab receipt package is ambiguous"));
    }
    if package["tab"]["distribution"]["sha256"].as_str() != Some(&sha) {
        return Err(invalid("retained tab archive checksum mismatch"));
    }
    let payload = cadencr_registry_core::read_tab_archive_bytes(&archive).map_err(invalid)?;
    let (_, signed) = verify_package(package, &payload)?;
    let mut files = BTreeMap::from([
        (PathBuf::from(RECEIPT), Expected::Bytes(receipt_bytes)),
        (PathBuf::from(WEB_ARCHIVE), Expected::Bytes(archive)),
    ]);
    let mut backend_sha = None;
    if let Some(signed) = &signed {
        let (_, target) = super::super::backend::signed_target(&receipt, signed)?;
        backend_sha = Some(target.sha256.clone());
        files.insert(
            PathBuf::from(super::super::backend::ARCHIVE),
            Expected::Digest {
                sha256: target.sha256.clone(),
                limit: cadencr_registry_core::MAX_TAB_BACKEND_ARCHIVE_BYTES,
                executable: false,
            },
        );
        files.insert(
            Path::new(id).join(&target.cmd),
            Expected::Digest {
                sha256: target.executable_sha256.clone(),
                limit: cadencr_registry_core::MAX_TAB_BACKEND_EXECUTABLE_BYTES,
                executable: true,
            },
        );
    }
    let name = revision
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if is_revision(name) && name != super::super::revision_id(&sha, backend_sha.as_deref()) {
        return Err(invalid("retained tab archive identity mismatch"));
    }
    for (name, bytes) in payload {
        files.insert(Path::new(id).join(name), Expected::Bytes(bytes));
    }
    let mut directories = BTreeSet::new();
    for (path, expected) in &files {
        let suspicious = match expected {
            Expected::Bytes(bytes) => database(path, bytes),
            Expected::Digest { .. } => database(path, b""),
        };
        if suspicious || !expected.holds(&revision.join(path))? {
            return Err(invalid("retained tab contains preserved or changed files"));
        }
        for parent in path
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            directories.insert(parent.to_owned());
        }
    }
    let plan = Plan { files, directories };
    exact_tree(root, revision, Path::new(""), &plan)?;
    Ok(plan)
}
pub(super) fn database(path: &Path, bytes: &[u8]) -> bool {
    let name = path.to_string_lossy().to_ascii_lowercase();
    bytes.starts_with(b"SQLite format 3\0")
        || [".db", ".sqlite", ".sqlite3", ".mdb", ".duckdb"]
            .iter()
            .any(|extension| name.contains(extension))
}
fn exact_tree(root: &Path, revision: &Path, relative: &Path, plan: &Plan) -> Result<(), AppError> {
    let directory = revision.join(relative);
    check_directory(root, &directory)?;
    for entry in std::fs::read_dir(&directory).map_err(invalid)? {
        let entry = entry.map_err(invalid)?;
        let path = relative.join(entry.file_name());
        let kind = entry.file_type().map_err(invalid)?;
        if kind.is_dir() && plan.directories.contains(&path) {
            exact_tree(root, revision, &path, plan)?;
        } else if !kind.is_file() || !plan.files.contains_key(&path) {
            return Err(invalid("retained tab contains unknown files"));
        }
    }
    Ok(())
}
pub(super) fn remove(revision: &Path, plan: &Plan) -> Result<(), AppError> {
    // Never remove_dir_all: unexpected late additions remain untouched. Recheck
    // bounded regular bytes (including hardlink/permissions checks) before unlink.
    // A published revision is sealed read-only: its folders (the proven ones
    // only, never through a symlink) get their owner write bit back first.
    let unseal = super::super::filesystem::unseal_directory;
    unseal(revision)?;
    for directory in &plan.directories {
        unseal(&revision.join(directory))?;
    }
    for (path, expected) in &plan.files {
        let path = revision.join(path);
        if !expected.holds(&path)? {
            return Err(invalid("retained tab changed during collection"));
        }
        std::fs::remove_file(path).map_err(invalid)?;
    }
    let mut directories: Vec<_> = plan.directories.iter().collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in directories {
        std::fs::remove_dir(revision.join(path)).map_err(invalid)?;
    }
    std::fs::remove_dir(revision).map_err(invalid)
}

#[cfg(test)]
mod tests {
    use crate::domain::plugin_tabs::managed::storage::{self, fixtures::fixture_for};

    #[test]
    fn intact_history_excluded_by_current_host_maximum_is_still_collectable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let (old, archive, files, _) = fixture_for()
            .root(&temp.path().join("old"))
            .maximum("0.1.0")
            .call();
        assert!(storage::catalog::resolve_kind(&old.index, "graph", &old.version, "tab").is_err());
        storage::commit(&root, &old, &archive, &files).unwrap();
        let old_directory = storage::directory(&root, "graph").unwrap().unwrap();
        for revision in 1..=2 {
            let (receipt, archive, files, _) = fixture_for()
                .root(&temp.path().join(format!("new-{revision}")))
                .revision(revision)
                .call();
            storage::commit(&root, &receipt, &archive, &files).unwrap();
        }
        assert!(!old_directory.exists());
        assert!(storage::directory(&root, "graph")
            .unwrap()
            .unwrap()
            .join("tab.json")
            .is_file());
    }
}
