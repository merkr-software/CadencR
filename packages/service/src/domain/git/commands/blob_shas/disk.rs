//! Blob SHAs of what the working tree holds: regular files through batched
//! `hash-object --stdin-paths`, symbolic links from their target text.

use std::path::Path;

use futures::stream::{self, StreamExt as _, TryStreamExt as _};

use crate::error::AppError;
use crate::shared::git_cli::{run_git_background_with_stdin, run_git_safe_background};

use super::{
    into_chunks, partition_by_kind, BATCH_CHUNK_SIZE, BATCH_CONCURRENCY, FALLBACK_CONCURRENCY,
};

/// SHAs of the files hashed, and what changed under the paths between the
/// listing and the hash.
#[derive(Default)]
pub(super) struct DiskShas {
    pub(super) shas: Vec<(String, String)>,
    /// Gone (or now a folder): deleted, they keep their `HEAD` blob like any
    /// other deleted file.
    pub(super) vanished: Vec<String>,
    /// Replaced by a symbolic link: hashed as one.
    pub(super) relinked: Vec<String>,
}

impl DiskShas {
    fn merge(&mut self, other: DiskShas) {
        self.shas.extend(other.shas);
        self.vanished.extend(other.vanished);
        self.relinked.extend(other.relinked);
    }
}

/// `git hash-object --stdin-paths` splits on `\n` (trimming `\r\n`) and
/// C-unquotes lines starting with `"`. Paths with those characters fall back to
/// single-file `hash-object -- <path>` so macOS and Linux behave identically.
fn is_hash_object_batchable(path: &str) -> bool {
    !path.contains(['\n', '\r', '\0']) && !path.starts_with('"')
}

pub(super) async fn hash_regular_files(
    worktree_path: &Path,
    paths: Vec<String>,
) -> Result<DiskShas, AppError> {
    let (batchable, special): (Vec<String>, Vec<String>) = paths
        .into_iter()
        .partition(|path| is_hash_object_batchable(path));
    // Batches and single-path fallbacks run side by side, each with its own
    // concurrency: a batch is already 500 files.
    let (batched, single) = tokio::try_join!(
        hash_all(
            worktree_path,
            into_chunks(batchable, BATCH_CHUNK_SIZE),
            BATCH_CONCURRENCY
        ),
        hash_all(
            worktree_path,
            special.into_iter().map(|path| vec![path]).collect(),
            FALLBACK_CONCURRENCY,
        ),
    )?;
    let mut all = batched;
    all.merge(single);
    Ok(all)
}

async fn hash_all(
    worktree_path: &Path,
    chunks: Vec<Vec<String>>,
    concurrency: usize,
) -> Result<DiskShas, AppError> {
    let hashed: Vec<DiskShas> = stream::iter(chunks)
        .map(|chunk| hash_tolerating_vanished(worktree_path, chunk))
        .buffer_unordered(concurrency)
        .try_collect()
        .await?;
    let mut all = DiskShas::default();
    for part in hashed {
        all.merge(part);
    }
    Ok(all)
}

/// Hash `chunk`; when Git fails because files vanished (or became links)
/// since they were listed, set those aside and hash the rest. Any other failure (a file Git
/// cannot read) fails the request, rather than passing for unchanged.
async fn hash_tolerating_vanished(
    worktree_path: &Path,
    mut chunk: Vec<String>,
) -> Result<DiskShas, AppError> {
    let mut set_aside = DiskShas::default();
    while !chunk.is_empty() {
        let error = match hash_chunk(worktree_path, &chunk).await {
            Ok(shas) => {
                set_aside.shas = shas;
                return Ok(set_aside);
            }
            Err(error) => error,
        };
        let kinds = partition_by_kind(worktree_path, chunk).await?;
        if kinds.symlinks.is_empty() && kinds.other.is_empty() {
            return Err(error);
        }
        set_aside.relinked.extend(kinds.symlinks);
        set_aside.vanished.extend(kinds.other);
        chunk = kinds.regular;
    }
    Ok(set_aside)
}

async fn hash_chunk(
    worktree_path: &Path,
    chunk: &[String],
) -> Result<Vec<(String, String)>, AppError> {
    if let [path] = chunk {
        if !is_hash_object_batchable(path) {
            let sha =
                run_git_safe_background(&["hash-object"], &[], &[path.as_str()], worktree_path)
                    .await?;
            let sha = sha.trim();
            return Ok(if sha.is_empty() {
                Vec::new()
            } else {
                vec![(path.clone(), sha.to_string())]
            });
        }
    }
    let stdin_len: usize = chunk.iter().map(|path| path.len() + 1).sum();
    let mut stdin = String::with_capacity(stdin_len);
    for path in chunk {
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
    Ok(chunk
        .iter()
        .zip(lines)
        .filter_map(|(path, sha)| {
            let sha = sha.trim();
            (!sha.is_empty()).then(|| (path.clone(), sha.to_string()))
        })
        .collect())
}

/// Git stores a symbolic link as a blob holding its target, but
/// `hash-object <path>` follows the link and hashes the file it points to (or
/// fails on a dangling link), so links are hashed from `readlink` instead.
pub(super) async fn hash_symlinks(
    worktree_path: &Path,
    links: Vec<String>,
) -> Result<DiskShas, AppError> {
    let hashed: Vec<(String, Option<String>)> = stream::iter(links)
        .map(|path| async move {
            let target = match tokio::fs::read_link(worktree_path.join(&path)).await {
                Ok(target) => target,
                Err(error) if super::super::diff_side::is_missing(&error) => {
                    return Ok((path, None))
                }
                Err(error) => {
                    return Err(AppError::internal(format!(
                        "cannot read the link {path}: {error}"
                    )))
                }
            };
            let sha = run_git_background_with_stdin(
                &["hash-object", "--stdin"],
                worktree_path,
                target.as_os_str().as_encoded_bytes(),
            )
            .await?;
            Ok::<_, AppError>((path, Some(sha.trim().to_string())))
        })
        .buffer_unordered(FALLBACK_CONCURRENCY)
        .try_collect()
        .await?;
    let mut all = DiskShas::default();
    for (path, sha) in hashed {
        match sha {
            Some(sha) => all.shas.push((path, sha)),
            None => all.vanished.push(path),
        }
    }
    Ok(all)
}
