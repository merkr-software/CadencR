//! `get_file_blob_shas`: collect blob SHAs for every file that's changed
//! in the working copy or relative to the feature's base branch. Used by the
//! diff viewer to key its per-file caches and to retire review comments.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use futures::stream::{self, StreamExt as _, TryStreamExt as _};

use crate::error::AppError;
use crate::shared::git_cli::{
    git_ref_resolves_background, guard_positionals, head_commit_exists, parse_batch_check_line,
    run_git_background, run_git_background_with_stdin, run_git_output_background,
    run_git_probe_background, run_git_safe_background, BatchCheckEntry,
};
use crate::shared::git_z;

use super::util::missing_target_branch;

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
        return Err(missing_target_branch(base_branch));
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

    let (on_disk, off_disk) = partition_by_regular_file(worktree_path, candidates).await?;
    let (disk_shas, head_shas) = tokio::try_join!(
        hash_on_disk_files(worktree_path, on_disk),
        lookup_head_blobs(worktree_path, off_disk, has_head),
    )?;

    let mut result = HashMap::with_capacity(disk_shas.len() + head_shas.len());
    result.extend(disk_shas);
    result.extend(head_shas);
    Ok(result)
}

/// Classify paths into regular on-disk files vs non-regular/missing entries
/// (deleted files, submodules, directory links) using bounded concurrency.
async fn partition_by_regular_file(
    worktree_path: &Path,
    paths: Vec<String>,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    let inspected: Vec<(String, bool)> = stream::iter(paths)
        .map(|file_path| async move {
            let is_file = match tokio::fs::metadata(worktree_path.join(&file_path)).await {
                Ok(metadata) => metadata.is_file(),
                // Gone, or under a folder replaced by a file (`ENOTDIR`): deleted.
                Err(error) if super::diff_side::is_missing(&error) => false,
                Err(error) => {
                    return Err(AppError::internal(format!(
                        "cannot inspect {file_path}: {error}"
                    )))
                }
            };
            Ok((file_path, is_file))
        })
        .buffer_unordered(METADATA_CONCURRENCY)
        .try_collect()
        .await?;

    let mut on_disk = Vec::new();
    let mut off_disk = Vec::new();
    for (path, is_file) in inspected {
        if is_file {
            on_disk.push(path);
        } else {
            off_disk.push(path);
        }
    }
    Ok((on_disk, off_disk))
}

/// `git hash-object --stdin-paths` splits on `\n` (trimming `\r\n`) and
/// C-unquotes lines starting with `"`. Paths with those characters fall back to
/// single-file `hash-object -- <path>` so macOS and Linux behave identically.
fn is_hash_object_batchable(path: &str) -> bool {
    !path.contains(['\n', '\r', '\0']) && !path.starts_with('"')
}

fn is_cat_file_batchable(path: &str) -> bool {
    !path.contains(['\n', '\r', '\0'])
}

fn into_chunks(mut items: Vec<String>, chunk_size: usize) -> Vec<Vec<String>> {
    let mut chunks = Vec::with_capacity(items.len().div_ceil(chunk_size));
    while !items.is_empty() {
        let split_at = items.len().saturating_sub(chunk_size);
        chunks.push(items.split_off(split_at));
    }
    chunks
}

async fn hash_on_disk_files(
    worktree_path: &Path,
    paths: Vec<String>,
) -> Result<Vec<(String, String)>, AppError> {
    let (batchable, special): (Vec<String>, Vec<String>) = paths
        .into_iter()
        .partition(|path| is_hash_object_batchable(path));

    let batch_fut = async {
        if batchable.is_empty() {
            return Ok::<Vec<(String, String)>, AppError>(Vec::new());
        }
        let chunk_results: Vec<Vec<(String, String)>> =
            stream::iter(into_chunks(batchable, BATCH_CHUNK_SIZE))
                .map(|chunk| hash_on_disk_chunk(worktree_path, chunk))
                .buffer_unordered(BATCH_CONCURRENCY)
                .try_collect()
                .await?;
        Ok(chunk_results.into_iter().flatten().collect())
    };

    let special_fut = async {
        if special.is_empty() {
            return Ok::<Vec<(String, String)>, AppError>(Vec::new());
        }
        let special_shas: Vec<Option<(String, String)>> = stream::iter(special)
            .map(|path| async move {
                let sha =
                    run_git_safe_background(&["hash-object"], &[], &[path.as_str()], worktree_path)
                        .await?;
                let sha = sha.trim().to_string();
                Ok::<_, AppError>((!sha.is_empty()).then_some((path, sha)))
            })
            .buffer_unordered(FALLBACK_CONCURRENCY)
            .try_collect()
            .await?;
        Ok(special_shas.into_iter().flatten().collect())
    };

    let (mut results, special_results) = tokio::try_join!(batch_fut, special_fut)?;
    results.extend(special_results);
    Ok(results)
}

async fn hash_on_disk_chunk(
    worktree_path: &Path,
    chunk: Vec<String>,
) -> Result<Vec<(String, String)>, AppError> {
    let stdin_len: usize = chunk.iter().map(|path| path.len() + 1).sum();
    let mut stdin = String::with_capacity(stdin_len);
    for path in &chunk {
        stdin.push_str(path);
        stdin.push('\n');
    }
    let stdout = run_git_background_with_stdin(
        &["hash-object", "--stdin-paths"],
        worktree_path,
        stdin.as_bytes(),
    )
    .await?;
    let lines: Vec<&str> = stdout.lines().collect();
    if lines.len() != chunk.len() {
        return Err(AppError::git_command(format!(
            "git hash-object --stdin-paths returned {} hashes for {} paths",
            lines.len(),
            chunk.len()
        )));
    }
    let mut out = Vec::with_capacity(chunk.len());
    for (path, sha) in chunk.into_iter().zip(lines) {
        let sha = sha.trim();
        if !sha.is_empty() {
            out.push((path, sha.to_string()));
        }
    }
    Ok(out)
}

async fn lookup_head_blobs(
    worktree_path: &Path,
    paths: Vec<String>,
    has_head: bool,
) -> Result<Vec<(String, String)>, AppError> {
    if !has_head || paths.is_empty() {
        return Ok(Vec::new());
    }
    let (batchable, special): (Vec<String>, Vec<String>) = paths
        .into_iter()
        .partition(|path| is_cat_file_batchable(path));

    let batch_fut = async {
        if batchable.is_empty() {
            return Ok::<Vec<(String, String)>, AppError>(Vec::new());
        }
        let chunk_results: Vec<Vec<(String, String)>> =
            stream::iter(into_chunks(batchable, BATCH_CHUNK_SIZE))
                .map(|chunk| lookup_head_chunk(worktree_path, chunk))
                .buffer_unordered(BATCH_CONCURRENCY)
                .try_collect()
                .await?;
        Ok(chunk_results.into_iter().flatten().collect())
    };

    let special_fut = async {
        if special.is_empty() {
            return Ok::<Vec<(String, String)>, AppError>(Vec::new());
        }
        let special_shas: Vec<Option<(String, String)>> = stream::iter(special)
            .map(|path| async move {
                let entry = format!("HEAD:{path}");
                let sha = run_git_probe_background(
                    &["rev-parse", "--verify", "--quiet", &entry],
                    worktree_path,
                )
                .await?
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
                Ok::<_, AppError>(sha.map(|s| (path, s)))
            })
            .buffer_unordered(FALLBACK_CONCURRENCY)
            .try_collect()
            .await?;
        Ok(special_shas.into_iter().flatten().collect())
    };

    let (mut results, special_results) = tokio::try_join!(batch_fut, special_fut)?;
    results.extend(special_results);
    Ok(results)
}

async fn lookup_head_chunk(
    worktree_path: &Path,
    chunk: Vec<String>,
) -> Result<Vec<(String, String)>, AppError> {
    let stdin_len: usize = chunk.iter().map(|path| path.len() + 6).sum();
    let mut stdin = String::with_capacity(stdin_len);
    for path in &chunk {
        stdin.push_str("HEAD:");
        stdin.push_str(path);
        stdin.push('\n');
    }
    let stdout = run_git_background_with_stdin(
        &["cat-file", "--batch-check=%(objectname)"],
        worktree_path,
        stdin.as_bytes(),
    )
    .await?;
    let lines: Vec<&str> = stdout.lines().collect();
    if lines.len() != chunk.len() {
        return Err(AppError::git_command(format!(
            "git cat-file --batch-check returned {} entries for {} paths",
            lines.len(),
            chunk.len()
        )));
    }
    let mut out = Vec::with_capacity(chunk.len());
    for (path, line) in chunk.into_iter().zip(lines) {
        match parse_batch_check_line(line) {
            Some(BatchCheckEntry::Object(oid) | BatchCheckEntry::Submodule(oid)) => {
                out.push((path, oid.to_string()));
            }
            Some(BatchCheckEntry::Missing { .. }) => {}
            None => {
                return Err(AppError::git_command(format!(
                    "unexpected git cat-file --batch-check output: {line:?}"
                )));
            }
        }
    }
    Ok(out)
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
            Err(AppError::Conflict(_))
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
}
