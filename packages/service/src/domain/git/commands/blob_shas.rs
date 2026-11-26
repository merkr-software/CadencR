//! `get_file_blob_shas`: collect blob SHAs for every file that's changed
//! in the working copy or relative to the feature's base branch. Used by the
//! diff viewer to key its per-file caches and to retire review comments.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use futures::stream::{self, StreamExt as _, TryStreamExt as _};

use crate::error::AppError;
use crate::shared::git_cli::{
    git_ref_resolves_background, guard_positionals, head_commit_exists, run_git_background,
    run_git_output_background,
};
use crate::shared::git_z;

use super::util::missing_target_branch_message;

const MISSING_TARGET_BRANCH: &str = "MISSING_TARGET_BRANCH";

mod disk;
mod head;

const METADATA_CONCURRENCY: usize = 32;
const FALLBACK_CONCURRENCY: usize = 16;
const BATCH_CONCURRENCY: usize = 4;
const BATCH_CHUNK_SIZE: usize = 500;

/// The paths of a `--name-only -z` style listing.
fn name_set(output: &str) -> HashSet<String> {
    git_z::paths(output).into_iter().collect()
}

/// Files changed on the branch since it forked from `base_branch`. A base
/// that shares no history with `HEAD` has no branch changes; a missing base
/// and every other Git failure are errors.
async fn branch_changed_files(
    worktree_path: &Path,
    base_branch: &str,
    has_head: bool,
) -> Result<HashSet<String>, AppError> {
    if !has_head {
        return Ok(HashSet::new());
    }
    // A base that cannot be resolved would make every committed file look
    // gone; refuse instead so the viewer pauses comment retirement.
    if !git_ref_resolves_background(base_branch, worktree_path).await? {
        return Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            MISSING_TARGET_BRANCH,
            missing_target_branch_message(base_branch),
        ));
    }
    let output =
        run_git_output_background(&["merge-base", "HEAD", base_branch], worktree_path).await?;
    let merge_base = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match output.status.code() {
        Some(0) if !merge_base.is_empty() => {}
        // Exit 1 with no output: no common ancestor.
        Some(1) if merge_base.is_empty() => return Ok(HashSet::new()),
        _ => {
            return Err(AppError::git_command(format!(
                "git merge-base HEAD {base_branch} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
    Ok(name_set(
        &run_git_background(
            &["diff", &merge_base, "HEAD", "--name-only", "-z", "--"],
            worktree_path,
        )
        .await?,
    ))
}

/// Get blob SHAs for all changed files (worktree + branch changes).
///
/// Listing failures are errors, never an empty map: the diff viewer treats a
/// file missing from this map as changed, and auto-deletes the review
/// comments anchored to it. A listed file that exists neither in the working
/// tree nor in `HEAD` is deleted, and is left out on purpose.
pub async fn get_file_blob_shas(
    feature_path: &Path,
    base_branch: &str,
) -> Result<HashMap<String, String>, AppError> {
    // Paths are keyed relative to the repository root, like the changed-file
    // list review comments are anchored to. A monorepo project's feature path
    // is a subdirectory, where `ls-files` and `hash-object` would otherwise
    // resolve paths relative to it.
    let top = run_git_background(&["rev-parse", "--show-toplevel"], feature_path).await?;
    let repo_root = std::path::PathBuf::from(top.trim());
    let worktree_path = repo_root.as_path();
    // An unborn branch has no HEAD to diff against; its tracked changes are
    // exactly what is staged.
    let has_head = head_commit_exists(worktree_path).await?;
    let changed_args: &[&str] = if has_head {
        &["diff", "HEAD", "--name-only", "-z", "--"]
    } else {
        &["diff", "--cached", "--name-only", "-z"]
    };
    let (changed_out, untracked_out, mut all_paths) = tokio::try_join!(
        run_git_background(changed_args, worktree_path),
        run_git_background(
            &["ls-files", "--others", "--exclude-standard", "-z"],
            worktree_path
        ),
        branch_changed_files(worktree_path, base_branch, has_head),
    )?;
    all_paths.extend(git_z::paths(&changed_out));
    all_paths.extend(git_z::paths(&untracked_out));

    let candidates: Vec<String> = all_paths
        .into_iter()
        .filter(|path| guard_positionals(&[path.as_str()]).is_ok())
        .collect();

    let kinds = partition_by_kind(worktree_path, candidates).await?;
    let (files, links, head_shas) = tokio::try_join!(
        disk::hash_regular_files(worktree_path, kinds.regular),
        disk::hash_symlinks(worktree_path, kinds.symlinks),
        head::lookup_head_blobs(worktree_path, kinds.other, has_head),
    )?;
    // Files deleted while they were being hashed are deleted files too; a
    // file that became a link is hashed as one.
    let relinked = disk::hash_symlinks(worktree_path, files.relinked).await?;
    let vanished = [files.vanished, links.vanished, relinked.vanished].concat();
    let vanished_shas = head::lookup_head_blobs(worktree_path, vanished, has_head).await?;

    let mut result = HashMap::with_capacity(files.shas.len() + head_shas.len());
    result.extend(files.shas);
    result.extend(links.shas);
    result.extend(relinked.shas);
    result.extend(head_shas);
    result.extend(vanished_shas);
    Ok(result)
}

/// Changed paths by what the working tree holds at each.
struct PathKinds {
    regular: Vec<String>,
    symlinks: Vec<String>,
    /// Gone, a folder (a submodule, a directory replacing a file), or
    /// anything else that is not a blob on disk: read from `HEAD`.
    other: Vec<String>,
}

/// Classify paths with bounded concurrency, without following links: a link
/// is its own blob, whatever it points to.
async fn partition_by_kind(
    worktree_path: &Path,
    paths: Vec<String>,
) -> Result<PathKinds, AppError> {
    let inspected: Vec<(String, Option<std::fs::FileType>)> = stream::iter(paths)
        .map(|file_path| async move {
            match tokio::fs::symlink_metadata(worktree_path.join(&file_path)).await {
                Ok(metadata) => Ok((file_path, Some(metadata.file_type()))),
                // Gone, or under a folder replaced by a file (`ENOTDIR`): deleted.
                Err(error) if super::diff_side::is_missing(&error) => Ok((file_path, None)),
                Err(error) => Err(AppError::internal(format!(
                    "cannot inspect {file_path}: {error}"
                ))),
            }
        })
        .buffer_unordered(METADATA_CONCURRENCY)
        .try_collect()
        .await?;

    let mut kinds = PathKinds {
        regular: Vec::new(),
        symlinks: Vec::new(),
        other: Vec::new(),
    };
    for (path, file_type) in inspected {
        match file_type {
            Some(kind) if kind.is_file() => kinds.regular.push(path),
            Some(kind) if kind.is_symlink() => kinds.symlinks.push(path),
            _ => kinds.other.push(path),
        }
    }
    Ok(kinds)
}

/// Split `items` into chunks of at most `chunk_size`.
fn into_chunks(mut items: Vec<String>, chunk_size: usize) -> Vec<Vec<String>> {
    let mut chunks = Vec::with_capacity(items.len().div_ceil(chunk_size));
    while !items.is_empty() {
        let split_at = items.len().saturating_sub(chunk_size);
        chunks.push(items.split_off(split_at));
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

    async fn git(args: &[&str], cwd: &Path) {
        run_git(args, cwd).await.unwrap();
    }

    /// Repo whose base branch is `develop` (no `main`/`master`), with a
    /// feature branch that committed `feature.txt`.
    async fn repo_on_develop() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git(&["init", "-q", "-b", "develop"], path).await;
        git(&["config", "user.email", "test@example.com"], path).await;
        git(&["config", "user.name", "Test"], path).await;
        git(&["config", "commit.gpgsign", "false"], path).await;
        std::fs::write(path.join("base.txt"), "base").unwrap();
        git(&["add", "base.txt"], path).await;
        git(&["commit", "-qm", "base"], path).await;
        git(&["checkout", "-qb", "feature/x"], path).await;
        std::fs::write(path.join("feature.txt"), "work").unwrap();
        git(&["add", "feature.txt"], path).await;
        git(&["commit", "-qm", "work"], path).await;
        dir
    }

    #[tokio::test]
    async fn a_committed_file_stays_listed_against_a_non_main_base() {
        // A file the agent committed leaves `git diff HEAD`; only the branch
        // diff keeps it in the map, so its review comments are not retired.
        let repo = repo_on_develop().await;
        let shas = get_file_blob_shas(repo.path(), "develop").await.unwrap();
        assert!(shas.contains_key("feature.txt"), "{shas:?}");
        assert!(!shas.contains_key("base.txt"));
    }

    #[tokio::test]
    async fn a_missing_base_branch_is_refused_not_an_empty_branch_diff() {
        let repo = repo_on_develop().await;
        assert!(matches!(
            get_file_blob_shas(repo.path(), "main").await,
            Err(AppError::Coded {
                status: axum::http::StatusCode::CONFLICT,
                code: MISSING_TARGET_BRANCH,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_subdirectory_feature_path_keys_files_from_the_repository_root() {
        let repo = repo_on_develop().await;
        let app = repo.path().join("packages/app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("new.ts"), "untracked").unwrap();
        std::fs::write(repo.path().join("feature.txt"), "edited").unwrap();

        let shas = get_file_blob_shas(&app, "develop").await.unwrap();

        assert!(shas.contains_key("packages/app/new.ts"), "{shas:?}");
        let edited = run_git(&["hash-object", "feature.txt"], repo.path())
            .await
            .unwrap();
        assert_eq!(
            shas.get("feature.txt").map(String::as_str),
            Some(edited.trim())
        );
    }

    /// Without `-z` these names came back C-quoted or split, failed both
    /// lookups and were dropped, retiring their review comments.
    #[tokio::test]
    async fn awkward_file_names_keep_their_blob_shas() {
        let repo = repo_on_develop().await;
        let names = ["café é.txt", "line\nbreak.txt", "with space.txt"];
        std::fs::write(repo.path().join(names[0]), "committed").unwrap();
        git(&["add", "-A"], repo.path()).await;
        git(&["commit", "-qm", "accented"], repo.path()).await;
        std::fs::write(repo.path().join(names[1]), "untracked").unwrap();
        std::fs::write(repo.path().join("base.txt"), "edited").unwrap();
        git(&["mv", "base.txt", names[2]], repo.path()).await;

        let shas = get_file_blob_shas(repo.path(), "develop").await.unwrap();

        for name in names {
            assert!(shas.contains_key(name), "{name:?} missing from {shas:?}");
        }
    }

    #[tokio::test]
    async fn listing_failures_are_errors_not_an_empty_map() {
        let not_a_repo = tempfile::tempdir().unwrap();
        assert!(get_file_blob_shas(not_a_repo.path(), "main").await.is_err());
    }

    /// A deleted file keeps its `HEAD` blob; a file Git cannot hash is an
    /// error. It used to fall back to the `HEAD` blob, reading as unchanged.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unhashable_file_is_an_error_not_its_head_blob() {
        if !crate::shared::test_dirs::permissions_bind() {
            return;
        }
        use std::os::unix::fs::PermissionsExt as _;

        let repo = repo_on_develop().await;
        let path = repo.path();
        std::fs::remove_file(path.join("base.txt")).unwrap();
        let shas = get_file_blob_shas(path, "develop").await.unwrap();
        assert!(shas.contains_key("base.txt"), "{shas:?}");

        let feature = path.join("feature.txt");
        std::fs::write(&feature, "edited").unwrap();
        std::fs::set_permissions(&feature, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = get_file_blob_shas(path, "develop").await;
        std::fs::set_permissions(&feature, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(result.is_err(), "{result:?}");
    }

    /// A folder replaced by a file of the same name leaves its files deleted:
    /// they keep their `HEAD` blob instead of failing the whole map.
    #[tokio::test]
    async fn a_folder_replaced_by_a_file_keeps_its_files_head_blobs() {
        let repo = repo_on_develop().await;
        let path = repo.path();
        std::fs::create_dir(path.join("folder")).unwrap();
        std::fs::write(path.join("folder/nested.txt"), "n").unwrap();
        git(&["add", "folder/nested.txt"], path).await;
        git(&["commit", "-qm", "folder"], path).await;
        std::fs::remove_dir_all(path.join("folder")).unwrap();
        std::fs::write(path.join("folder"), "now a file").unwrap();

        let shas = get_file_blob_shas(path, "develop").await.unwrap();
        assert!(shas.contains_key("folder/nested.txt"), "{shas:?}");
    }

    #[tokio::test]
    async fn batches_many_mixed_modified_untracked_deleted_and_special_files() {
        let repo = repo_on_develop().await;
        let path = repo.path();

        // Seed 60 tracked files on the feature branch.
        for i in 0..60 {
            let name = format!("batch/file_{i:02}.txt");
            let full = path.join(&name);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, format!("initial-{i}\n")).unwrap();
        }
        git(&["add", "-A"], path).await;
        git(&["commit", "-qm", "seed 60 files"], path).await;

        // Modify 20, delete 10, leave 30 committed on the branch, add 15 untracked,
        // plus special filenames (spaces, leading quote, accented, newline).
        for i in 0..20 {
            std::fs::write(
                path.join(format!("batch/file_{i:02}.txt")),
                format!("edited-{i}\n"),
            )
            .unwrap();
        }
        for i in 20..30 {
            std::fs::remove_file(path.join(format!("batch/file_{i:02}.txt"))).unwrap();
        }
        for i in 0..15 {
            std::fs::write(
                path.join(format!("untracked_{i:02}.txt")),
                format!("new-{i}\n"),
            )
            .unwrap();
        }
        let special_names = [
            "\"leading_quote.txt",
            "mid\"quote.txt",
            "with space.txt",
            "café é.txt",
            "line\nbreak.txt",
        ];
        for name in special_names {
            std::fs::write(path.join(name), format!("special-{name}")).unwrap();
        }

        let shas = get_file_blob_shas(path, "develop").await.unwrap();

        // All 60 tracked (modified, deleted -> HEAD blob, or committed on branch),
        // all 15 untracked, all 5 special names, and feature.txt must be present.
        assert!(shas.contains_key("feature.txt"));
        for i in 0..60 {
            let name = format!("batch/file_{i:02}.txt");
            assert!(shas.contains_key(&name), "missing {name}");
        }
        for i in 0..15 {
            let name = format!("untracked_{i:02}.txt");
            assert!(shas.contains_key(&name), "missing {name}");
        }
        for name in special_names {
            let expected = run_git(&["hash-object", "--", name], path).await.unwrap();
            assert_eq!(
                shas.get(name).map(String::as_str),
                Some(expected.trim()),
                "mismatch for {name:?}"
            );
        }
        // A deleted file's SHA must match its HEAD blob.
        let deleted_head = run_git(&["rev-parse", "HEAD:batch/file_25.txt"], path)
            .await
            .unwrap();
        assert_eq!(
            shas.get("batch/file_25.txt").map(String::as_str),
            Some(deleted_head.trim())
        );
    }

    #[test]
    fn chunks_split_at_the_batch_size_boundary() {
        let paths = |count: usize| (0..count).map(|i| format!("f{i}")).collect::<Vec<_>>();
        for (count, sizes) in [
            (0, vec![]),
            (1, vec![1]),
            (499, vec![499]),
            (500, vec![500]),
            (501, vec![500, 1]),
            (1000, vec![500, 500]),
            (1001, vec![500, 500, 1]),
        ] {
            let chunks = into_chunks(paths(count), BATCH_CHUNK_SIZE);
            let mut lens: Vec<usize> = chunks.iter().map(Vec::len).collect();
            lens.sort_unstable_by(|a, b| b.cmp(a));
            assert_eq!(lens, sizes, "{count} paths");
            let mut all: Vec<String> = chunks.into_iter().flatten().collect();
            all.sort();
            let mut expected = paths(count);
            expected.sort();
            assert_eq!(all, expected, "{count} paths");
        }
    }

    /// 501 changed files take two `hash-object` batches; every one of them
    /// keeps the SHA Git itself computes.
    #[tokio::test]
    async fn every_file_of_a_two_batch_change_is_hashed() {
        let repo = repo_on_develop().await;
        let path = repo.path();
        for i in 0..=BATCH_CHUNK_SIZE {
            std::fs::write(path.join(format!("u{i:03}.txt")), format!("{i}\n")).unwrap();
        }
        let shas = get_file_blob_shas(path, "develop").await.unwrap();
        for i in [0, BATCH_CHUNK_SIZE - 1, BATCH_CHUNK_SIZE] {
            let name = format!("u{i:03}.txt");
            let expected = run_git(&["hash-object", "--", &name], path).await.unwrap();
            assert_eq!(shas.get(&name).map(String::as_str), Some(expected.trim()));
        }
        assert_eq!(
            shas.keys().filter(|name| name.starts_with('u')).count(),
            BATCH_CHUNK_SIZE + 1
        );
    }

    /// A link is the blob of its target text, as `git add` stores it, not the
    /// content of the file it points to; a dangling link is no exception.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_keeps_the_blob_git_stores_for_it() {
        let repo = repo_on_develop().await;
        let path = repo.path();
        std::os::unix::fs::symlink("base.txt", path.join("link")).unwrap();
        git(&["add", "link"], path).await;
        git(&["commit", "-qm", "link"], path).await;
        std::fs::remove_file(path.join("link")).unwrap();
        std::os::unix::fs::symlink("feature.txt", path.join("link")).unwrap();
        std::os::unix::fs::symlink("nowhere", path.join("dangling")).unwrap();

        let shas = get_file_blob_shas(path, "develop").await.unwrap();

        git(&["add", "link", "dangling"], path).await;
        for name in ["link", "dangling"] {
            let staged = run_git(&["rev-parse", &format!(":{name}")], path)
                .await
                .unwrap();
            assert_eq!(
                shas.get(name).map(String::as_str),
                Some(staged.trim()),
                "{name}"
            );
        }
    }

    /// A submodule whose gitlink changed keeps the commit `HEAD` records for
    /// it: the folder on disk is no blob to hash.
    #[tokio::test]
    async fn a_submodule_keeps_the_commit_head_records() {
        let repo = repo_on_develop().await;
        let path = repo.path();
        let commit = run_git(&["rev-parse", "HEAD"], path).await.unwrap();
        let cacheinfo = format!("160000,{},sub", commit.trim());
        git(&["update-index", "--add", "--cacheinfo", &cacheinfo], path).await;
        git(&["commit", "-qm", "submodule"], path).await;
        std::fs::create_dir(path.join("sub")).unwrap();
        git(&["rm", "-q", "--cached", "sub"], path).await;

        let shas = get_file_blob_shas(path, "develop").await.unwrap();
        assert_eq!(
            shas.get("sub").map(String::as_str),
            Some(commit.trim()),
            "{shas:?}"
        );
    }

    /// A file deleted between the listing and the hash is a deleted file: it
    /// keeps its `HEAD` blob instead of failing every other file's hash. One
    /// replaced by a link in the meantime is set aside to be hashed as a link.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_file_deleted_or_relinked_while_hashing_is_set_aside() {
        let repo = repo_on_develop().await;
        let path = repo.path();
        std::fs::write(path.join("kept.txt"), "kept").unwrap();
        let listed = vec![
            "kept.txt".to_string(),
            "feature.txt".to_string(),
            "\"quoted gone.txt".to_string(),
            "now_a_link".to_string(),
        ];
        std::fs::remove_file(path.join("feature.txt")).unwrap();
        std::os::unix::fs::symlink("nowhere", path.join("now_a_link")).unwrap();

        let hashed = disk::hash_regular_files(path, listed).await.unwrap();

        let expected = run_git(&["hash-object", "kept.txt"], path).await.unwrap();
        assert_eq!(
            hashed.shas,
            vec![("kept.txt".to_string(), expected.trim().to_string())]
        );
        let mut vanished = hashed.vanished;
        vanished.sort();
        assert_eq!(vanished, ["\"quoted gone.txt", "feature.txt"]);
        assert_eq!(hashed.relinked, ["now_a_link"]);
    }
}
