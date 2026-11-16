//! Re-home paths recorded under a folder that moved, and compare folders
//! spelled different ways.

use std::path::{Path, PathBuf};

/// `path` under `to` instead of `from`, or `None` when `path` is not `from`
/// or inside it. Compared by components, so `/repo/app-other` is not inside
/// `/repo/app`.
pub fn rebase(path: &Path, from: &Path, to: &Path) -> Option<PathBuf> {
    let rest = path.strip_prefix(from).ok()?;
    if rest.as_os_str().is_empty() {
        Some(to.to_path_buf())
    } else {
        Some(to.join(rest))
    }
}

/// [`rebase`] for a path stored as text.
pub fn rebase_str(path: &str, from: &Path, to: &Path) -> Option<String> {
    rebase(Path::new(path), from, to).map(|path| path.to_string_lossy().into_owned())
}

/// The same folder, also when one side is spelled through a symlink
/// (`/tmp` → `/private/tmp` on macOS) or with a trailing separator. A folder
/// that no longer exists can only match by its spelling.
pub fn same_folder(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => {
            let spelling = |path: &Path| path.to_string_lossy().trim_end_matches('/').to_string();
            spelling(left) == spelling(right)
        }
    }
}

/// The same file under two names: a change of letter case on a
/// case-insensitive volume (`App` → `app` on default macOS).
pub fn same_file(left: &Path, right: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(left), std::fs::metadata(right)) {
            (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_folder_sees_through_symlinks_and_trailing_separators() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(same_folder(&link, &real));
        }
        assert!(same_folder(Path::new("/gone/app/"), Path::new("/gone/app")));
        assert!(!same_folder(
            Path::new("/gone/app"),
            Path::new("/gone/other")
        ));
    }

    #[test]
    fn rebases_the_folder_and_what_it_contains() {
        let (from, to) = (Path::new("/repo/app"), Path::new("/work/renamed"));
        assert_eq!(rebase(from, from, to), Some(to.to_path_buf()));
        assert_eq!(
            rebase(Path::new("/repo/app/packages/web"), from, to),
            Some(PathBuf::from("/work/renamed/packages/web"))
        );
    }

    #[test]
    fn leaves_siblings_and_outsiders_alone() {
        let (from, to) = (Path::new("/repo/app"), Path::new("/work/renamed"));
        assert_eq!(rebase(Path::new("/repo/app-other"), from, to), None);
        assert_eq!(rebase(Path::new("/elsewhere"), from, to), None);
        assert_eq!(rebase_str("/repo", from, to), None);
    }
}
