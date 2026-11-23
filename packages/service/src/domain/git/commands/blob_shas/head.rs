//! Blob SHAs of files the working tree no longer holds, read from `HEAD`.

use std::path::Path;

use futures::stream::{self, StreamExt as _, TryStreamExt as _};

use crate::error::AppError;
use crate::shared::git_cli::{
    parse_batch_check_line, run_git_background_with_stdin, run_git_probe_background,
    BatchCheckEntry,
};

use super::{into_chunks, BATCH_CHUNK_SIZE, BATCH_CONCURRENCY, FALLBACK_CONCURRENCY};

/// `cat-file --batch-check` reads one spec per line.
fn is_cat_file_batchable(path: &str) -> bool {
    !path.contains(['\n', '\r', '\0'])
}

/// The `HEAD` blob of each path; a path `HEAD` does not hold has none. A
/// submodule's entry is the commit it points to.
pub(super) async fn lookup_head_blobs(
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
