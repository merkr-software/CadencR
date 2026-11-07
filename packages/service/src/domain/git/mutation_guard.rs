use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Process-local single-flight boundary for foreground Git mutations.
///
/// `AppState` owns one shared instance. Every later index, stash, and
/// update-branch handler must acquire a permit after resolving the feature's
/// worktree and before spawning Git. Slots are keyed by the canonical root of
/// the worktree that owns the path, so linked aliases and the subdirectory a
/// monorepo project lives in all contend for the one index they share;
/// background read commands remain outside this guard.
#[derive(Debug, Default)]
pub struct GitMutationGuard {
    /// Owning worktree root → the canonical path the holder asked for.
    active_worktrees: Mutex<HashMap<PathBuf, PathBuf>>,
}

impl GitMutationGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire the mutation slot for an existing worktree without waiting.
    /// A second request receives `Busy` instead of racing into `index.lock`.
    pub fn try_acquire(
        self: &Arc<Self>,
        worktree_path: &Path,
    ) -> Result<GitMutationPermit, GitMutationGuardError> {
        let canonical_path = std::fs::canonicalize(worktree_path).map_err(|source| {
            GitMutationGuardError::InvalidWorktree {
                path: worktree_path.to_path_buf(),
                source,
            }
        })?;
        let key = owning_worktree_root(&canonical_path);
        let mut active = self
            .active_worktrees
            .lock()
            .map_err(|_| GitMutationGuardError::RegistryUnavailable)?;
        if active.contains_key(&key) {
            return Err(GitMutationGuardError::Busy { worktree_path: key });
        }
        active.insert(key.clone(), canonical_path.clone());
        drop(active);

        Ok(GitMutationPermit {
            guard: Arc::clone(self),
            key,
            worktree_path: canonical_path,
        })
    }

    /// Whether Cadencr owns a foreground mutation for this canonical path:
    /// the worktree root a permit holds, or the exact path it was taken for.
    /// Exact matches only — a prefix would also silence sibling projects and
    /// nested worktrees that the post-mutation refresh never revisits. Watcher
    /// registry keys are already canonical, so this stays a lock-only hot-path
    /// lookup without synchronous filesystem I/O.
    pub fn is_active_canonical(&self, canonical_path: &Path) -> bool {
        let covers = |active: &HashMap<PathBuf, PathBuf>| {
            active
                .iter()
                .any(|(key, requested)| key == canonical_path || requested == canonical_path)
        };
        match self.active_worktrees.lock() {
            Ok(active) => covers(&active),
            Err(poisoned) => covers(&poisoned.into_inner()),
        }
    }
}

/// The nearest ancestor holding Git metadata (`.git` is a directory in the
/// main checkout and a file in a linked worktree), else the path itself. A Git
/// directory (such as the common dir stash commands also lock) is its own key:
/// it is the repository-global slot, distinct from any worktree's.
fn owning_worktree_root(canonical_path: &Path) -> PathBuf {
    if is_git_dir(canonical_path) {
        return canonical_path.to_path_buf();
    }
    canonical_path
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(canonical_path)
        .to_path_buf()
}

fn is_git_dir(path: &Path) -> bool {
    path.join("HEAD").is_file() && path.join("objects").is_dir()
}

/// RAII permit held for the full foreground Git command. Dropping it releases
/// the worktree slot on success, expected conflict, or early error.
#[derive(Debug)]
pub struct GitMutationPermit {
    guard: Arc<GitMutationGuard>,
    /// Registry slot: the owning worktree root.
    key: PathBuf,
    /// The canonical path the caller asked for, where its Git commands run.
    worktree_path: PathBuf,
}

impl GitMutationPermit {
    pub fn worktree_path(&self) -> &Path {
        &self.worktree_path
    }
}

impl Drop for GitMutationPermit {
    fn drop(&mut self) {
        match self.guard.active_worktrees.lock() {
            Ok(mut active) => {
                active.remove(&self.key);
            }
            Err(poisoned) => {
                poisoned.into_inner().remove(&self.key);
            }
        }
    }
}

#[derive(Debug)]
pub enum GitMutationGuardError {
    InvalidWorktree {
        path: PathBuf,
        source: std::io::Error,
    },
    Busy {
        worktree_path: PathBuf,
    },
    RegistryUnavailable,
}

impl fmt::Display for GitMutationGuardError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidWorktree { path, source } => write!(
                formatter,
                "could not resolve Git worktree {}: {source}",
                path.display()
            ),
            Self::Busy { worktree_path } => write!(
                formatter,
                "another Git mutation is already running for {}",
                worktree_path.display()
            ),
            Self::RegistryUnavailable => {
                formatter.write_str("the Git mutation registry is unavailable")
            }
        }
    }
}

impl std::error::Error for GitMutationGuardError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidWorktree { source, .. } => Some(source),
            Self::Busy { .. } | Self::RegistryUnavailable => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_mutations_by_canonical_worktree_path() {
        let worktree = tempfile::tempdir().unwrap();
        let guard = Arc::new(GitMutationGuard::new());
        let canonical = worktree.path().canonicalize().unwrap();
        assert!(!guard.is_active_canonical(&canonical));
        let permit = guard.try_acquire(worktree.path()).unwrap();
        assert!(guard.is_active_canonical(&canonical));

        let alias = worktree.path().join(".");
        let error = guard.try_acquire(&alias).unwrap_err();
        assert!(matches!(error, GitMutationGuardError::Busy { .. }));

        drop(permit);
        assert!(!guard.is_active_canonical(&canonical));
        assert!(guard.try_acquire(&alias).is_ok());
    }

    #[test]
    fn permits_different_worktrees_concurrently() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let guard = Arc::new(GitMutationGuard::new());

        let first_permit = guard.try_acquire(first.path()).unwrap();
        let second_permit = guard.try_acquire(second.path()).unwrap();

        assert_eq!(
            first_permit.worktree_path(),
            first.path().canonicalize().unwrap()
        );
        assert_eq!(
            second_permit.worktree_path(),
            second.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn a_monorepo_subdirectory_shares_its_worktree_slot() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir(repo.path().join(".git")).unwrap();
        let project = repo.path().join("packages/app");
        std::fs::create_dir_all(&project).unwrap();
        let guard = Arc::new(GitMutationGuard::new());

        let permit = guard.try_acquire(&project).unwrap();
        assert_eq!(permit.worktree_path(), project.canonicalize().unwrap());
        assert!(guard.is_active_canonical(&repo.path().canonicalize().unwrap()));
        assert!(matches!(
            guard.try_acquire(repo.path()).unwrap_err(),
            GitMutationGuardError::Busy { .. }
        ));

        drop(permit);
        let root_permit = guard.try_acquire(repo.path()).unwrap();
        assert!(guard.try_acquire(&project).is_err());
        // Watchers of other directories keep refreshing: only the slot's root
        // and the requested path are suppressed.
        assert!(!guard.is_active_canonical(&project.canonicalize().unwrap()));
        drop(root_permit);
    }

    #[test]
    fn a_git_directory_keeps_its_own_slot() {
        let repo = tempfile::tempdir().unwrap();
        let git_dir = repo.path().join(".git");
        std::fs::create_dir_all(git_dir.join("objects")).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let guard = Arc::new(GitMutationGuard::new());

        let _worktree = guard.try_acquire(repo.path()).unwrap();
        // Stash locks the worktree and the repository-global common dir.
        let _common = guard.try_acquire(&git_dir).unwrap();
    }

    #[test]
    fn rejects_a_missing_worktree_key() {
        let guard = Arc::new(GitMutationGuard::new());
        let missing = std::env::temp_dir().join("cadencr-missing-git-mutation-worktree");

        let error = guard.try_acquire(&missing).unwrap_err();
        assert!(matches!(
            error,
            GitMutationGuardError::InvalidWorktree { .. }
        ));
    }
}
