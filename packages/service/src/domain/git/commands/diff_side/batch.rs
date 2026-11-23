use std::path::Path;

use crate::domain::git::commands::util::read_file_prefix;
use crate::domain::git::file_size::{
    BatchSide, BinarySniffer, BINARY_SNIFF_BYTES, LARGE_FILE_BYTES, MAX_SINGLE_FILE_SIDE_BYTES,
};
use crate::error::AppError;
use crate::shared::bounded_command::feed_capped;
use crate::shared::git_cli::{
    guard_positionals, run_git_background_stream, run_git_safe_refs_background_bounded,
    BoundedGitOutput,
};

use super::{
    is_missing, read_error, resolve_tree_entry, resolve_worktree_file, submodule_side,
    subproject_commit, unsupported_file_type,
};

/// Like `read_side`, for batch diff classification: files at or above
/// [`LARGE_FILE_BYTES`] are never held in memory — we keep their real byte
/// size and stream them through a [`BinarySniffer`], so `is_binary` says what
/// the single-file endpoint will say once the user opens the file. The stream
/// stops at the first proof of binary content (see `sniff_budget` for sides
/// that endpoint refuses).
pub(in crate::domain::git::commands) async fn read_side_for_batch(
    worktree_path: &Path,
    file_path: &str,
    ref_spec: Option<&str>,
) -> Result<BatchSide, AppError> {
    match ref_spec {
        None => read_worktree_side_for_batch(worktree_path, file_path).await,
        Some(reference) => read_tree_side_for_batch(worktree_path, reference, file_path).await,
    }
}

async fn read_tree_side_for_batch(
    worktree_path: &Path,
    reference: &str,
    file_path: &str,
) -> Result<BatchSide, AppError> {
    let Some(entry) = resolve_tree_entry(worktree_path, reference, file_path).await? else {
        return Ok(BatchSide::Missing);
    };
    match entry.kind.as_str() {
        "blob" => {
            let size = entry.size.unwrap_or(0);
            if size >= LARGE_FILE_BYTES {
                return sniff_large_blob(worktree_path, &entry.oid, size).await;
            }
            let oid = [entry.oid.as_str()];
            match run_git_safe_refs_background_bounded(
                &["cat-file", "blob"],
                &[],
                &oid,
                worktree_path,
                LARGE_FILE_BYTES as usize,
            )
            .await?
            {
                BoundedGitOutput::Bytes(bytes) => Ok(BatchSide::Inline(bytes)),
                BoundedGitOutput::ExceededLimit => {
                    sniff_large_blob(worktree_path, &entry.oid, size.max(LARGE_FILE_BYTES)).await
                }
            }
        }
        "commit" => Ok(BatchSide::Inline(subproject_commit(&entry.oid))),
        _ => Err(unsupported_file_type()),
    }
}

/// How much of a large side to stream for its verdict: all of it up to
/// [`MAX_SINGLE_FILE_SIDE_BYTES`]; past that the single-file endpoint refuses
/// the file, so its first 8 KiB (Git's own binary heuristic) are enough.
fn sniff_budget(size: u64) -> usize {
    if size > MAX_SINGLE_FILE_SIDE_BYTES as u64 {
        BINARY_SNIFF_BYTES
    } else {
        MAX_SINGLE_FILE_SIDE_BYTES
    }
}

async fn sniff_large_blob(
    worktree_path: &Path,
    oid: &str,
    size: u64,
) -> Result<BatchSide, AppError> {
    guard_positionals(&[oid])?;
    let mut sniffer = BinarySniffer::default();
    let mut fed = 0_u64;
    run_git_background_stream(
        &["cat-file", "blob", oid],
        worktree_path,
        sniff_budget(size),
        |chunk| {
            fed += chunk.len() as u64;
            sniffer.feed(chunk)
        },
    )
    .await?;
    Ok(BatchSide::Large {
        size,
        is_binary: sniffer.is_binary(fed >= size),
    })
}

/// [`sniff_large_blob`] for a working-tree file of `size` bytes (by its
/// metadata): the verdict, and how many bytes the file really held.
async fn sniff_large_file(file: &Path, size: u64) -> std::io::Result<(bool, u64)> {
    let reader = tokio::fs::File::open(file).await?;
    let mut sniffer = BinarySniffer::default();
    let mut fed = 0_u64;
    let complete = feed_capped(reader, sniff_budget(size), |chunk| {
        fed += chunk.len() as u64;
        sniffer.feed(chunk)
    })
    .await?;
    Ok((sniffer.is_binary(complete), fed.max(size)))
}

async fn read_worktree_side_for_batch(
    worktree_path: &Path,
    file_path: &str,
) -> Result<BatchSide, AppError> {
    let Some(file) = resolve_worktree_file(worktree_path, file_path)? else {
        return Ok(BatchSide::Missing);
    };
    let metadata = match tokio::fs::metadata(&file).await {
        Ok(metadata) => metadata,
        Err(error) if is_missing(&error) => return Ok(BatchSide::Missing),
        Err(error) => return Err(read_error(&file, &error)),
    };
    if metadata.is_dir() {
        return Ok(match submodule_side(&file).await? {
            Some(bytes) => BatchSide::Inline(bytes),
            None => BatchSide::Missing,
        });
    }
    let size = metadata.len();
    let limit = LARGE_FILE_BYTES as usize;
    if size < LARGE_FILE_BYTES {
        match read_file_prefix(&file, limit, Some(size)).await {
            // Grown past the threshold since `metadata`: large after all.
            Ok(bytes) if bytes.len() >= limit => {}
            Ok(bytes) => return Ok(BatchSide::Inline(bytes)),
            Err(error) if is_missing(&error) => return Ok(BatchSide::Missing),
            Err(error) => return Err(read_error(&file, &error)),
        }
    }
    match sniff_large_file(&file, size).await {
        Ok((is_binary, size)) => Ok(BatchSide::Large { size, is_binary }),
        Err(error) if is_missing(&error) => Ok(BatchSide::Missing),
        Err(error) => Err(read_error(&file, &error)),
    }
}
