//! Paths needed to observe symlink targets and replacements, including
//! dangling links whose targets cannot be canonicalized yet.

use std::path::{Path, PathBuf};

use super::state::normalize;

/// Include each link encountered along the path as an exact reload trigger,
/// then the final target. `read_link` works even when the target is missing.
/// Bound traversal like filesystem resolution so cyclic links cannot hang
/// watch-set computation; the config reader reports their read failure.
pub(super) fn watch_paths(path: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut current = path.to_path_buf();
    for _ in 0..40 {
        // Resolve the first symlink from the root down, before inspecting
        // any path component underneath it.
        let prefixes: Vec<_> = current.ancestors().collect();
        let link = prefixes
            .into_iter()
            .rev()
            .find_map(|prefix| prefix.read_link().ok().map(|target| (prefix, target)));
        let Some((prefix, target)) = link else {
            break;
        };
        let parent = prefix.parent().unwrap_or_else(|| Path::new(""));
        // System aliases such as /var on macOS must not add a watch on /.
        if parent.parent().is_some() {
            if let Some(name) = prefix.file_name() {
                paths.push(normalize(parent).join(name));
            }
        }
        let target = if target.is_absolute() {
            target
        } else {
            parent.join(target)
        };
        let remaining = current.strip_prefix(prefix).expect("path prefix");
        // Joining an empty suffix appends a separator, making the next
        // read_link treat a chained file symlink as a directory.
        current = if remaining.as_os_str().is_empty() {
            target
        } else {
            target.join(remaining)
        };
    }
    paths.push(normalize(&current));
    paths
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn follows_chained_relative_links_to_a_missing_target() {
        let dir = tempfile::tempdir().unwrap();
        let base = normalize(dir.path());
        let link = base.join("font.toml");
        let other = base.join("other.toml");
        let target = base.join("missing/font.toml");
        symlink("other.toml", &link).unwrap();
        symlink("missing/font.toml", &other).unwrap();

        assert_eq!(watch_paths(&link), vec![link, other, target]);
    }

    #[test]
    fn follows_a_directory_link_and_a_file_link_below_it() {
        let dir = tempfile::tempdir().unwrap();
        let base = normalize(dir.path());
        let themes = base.join("themes");
        std::fs::create_dir(&themes).unwrap();
        let directory_link = base.join("current");
        let file_link = themes.join("font.toml");
        let target = base.join("external/font.toml");
        symlink("themes", &directory_link).unwrap();
        symlink("../external/font.toml", &file_link).unwrap();

        assert_eq!(
            watch_paths(&directory_link.join("font.toml")),
            vec![directory_link, file_link, target]
        );
    }

    #[test]
    fn cyclic_links_finish_without_watching_the_filesystem_root() {
        let dir = tempfile::tempdir().unwrap();
        let base = normalize(dir.path());
        let link = base.join("font.toml");
        symlink("font.toml", &link).unwrap();

        let paths = watch_paths(&link);
        assert!(paths.len() <= 41);
        assert!(paths.iter().all(|path| path == &link));
        assert!(watch_paths(Path::new("/var/cadencr-missing/font.toml"))
            .iter()
            .all(|path| path.parent() != Some(Path::new("/"))));
    }
}
