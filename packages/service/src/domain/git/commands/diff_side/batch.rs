use std::path::Path;

use crate::domain::git::commands::util::read_file_prefix;
use crate::domain::git::file_size::{
    head_is_binary, BatchSide, BINARY_SNIFF_BYTES, LARGE_FILE_BYTES,
};
use crate::error::AppError;
use crate::shared::git_cli::{
    guard_positionals, run_git_background_head_bytes, run_git_safe_refs_background_bounded,
    BoundedGitOutput,
};

use super::{
    is_missing, read_error, resolve_tree_entry, resolve_worktree_file, submodule_side,
    subproject_commit, unsupported_file_type,
};

/// Like `read_side`, for batch diff classification: files at or above
/// [`LARGE_FILE_BYTES`] are never read into memory in full — we keep their real
/// byte size and sniff at most [`BINARY_SNIFF_BYTES`] for binary detection.
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

async fn sniff_large_blob(
    worktree_path: &Path,
    oid: &str,
    size: u64,
) -> Result<BatchSide, AppError> {
    guard_positionals(&[oid])?;
    let head = run_git_background_head_bytes(
        &["cat-file", "blob", oid],
        worktree_path,
        BINARY_SNIFF_BYTES,
    )
    .await?;
    Ok(BatchSide::Large {
        size,
        is_binary: head_is_binary(&head),
    })
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
    if size >= LARGE_FILE_BYTES {
        return match read_file_prefix(&file, BINARY_SNIFF_BYTES, Some(size)).await {
            Ok(head) => Ok(BatchSide::Large {
                size,
                is_binary: head_is_binary(&head),
            }),
            Err(error) if is_missing(&error) => Ok(BatchSide::Missing),
            Err(error) => Err(read_error(&file, &error)),
        };
    }
    let limit = LARGE_FILE_BYTES as usize;
    match read_file_prefix(&file, limit, Some(size)).await {
        Ok(bytes) if bytes.len() >= limit => Ok(BatchSide::Large {
            size: size.max(bytes.len() as u64),
            is_binary: head_is_binary(&bytes),
        }),
        Ok(bytes) => Ok(BatchSide::Inline(bytes)),
        Err(error) if is_missing(&error) => Ok(BatchSide::Missing),
        Err(error) => Err(read_error(&file, &error)),
    }
}
