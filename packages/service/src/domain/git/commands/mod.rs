//! Git command orchestration. Split into cohesive submodules so each
//! file stays small enough to read at a glance:
//!
//! - [`branch_name`] — `build_branch_name` (slug + random hex suffix).
//! - [`diff`] — `git diff` / `--stat` / `--numstat`, changed-files merging.
//! - [`files`] — single-file + batch `git show`, `ls-files`.
//! - [`log`] — commit log + `is_pushed` painting via `--not --remotes`.
//! - [`merge`] — `merge-tree`, `merge --no-ff`, `branch -d`,
//!   `get_original_branch` fallback chain, `get_current_branch`.
//! - [`pty`] — `commit_streaming` / `push_streaming` over `portable-pty`.
//! - [`worktree_ops`] — `worktree list/add/remove`, porcelain parsers.
//!
//! Public symbols are re-exported here so existing callers
//! (`crate::domain::git::commands::foo`) keep working without churn.

mod blob_shas;
mod branch_name;
mod changed_files;
mod diff;
mod files;
mod graph;
mod graph_refs;
mod index;
mod log;
mod merge;
mod merge_ops;
mod pty;
mod pty_input;
mod pty_spawn;
pub(crate) mod stash;
mod untracked;
mod util;
mod worktree_health;
mod worktree_ops;
mod worktree_removal;

pub use blob_shas::get_file_blob_shas;
pub use branch_name::build_branch_name;
pub use changed_files::get_changed_files;
pub(crate) use changed_files::get_uncommitted_entries;
pub use diff::{get_commit_diff, get_diff, get_file_diff, get_stats};
pub use files::{get_file_bytes, get_file_content_batch, list_files};
pub use graph::get_commit_graph;
pub use index::{reset_file, stage_file};
pub use log::{get_commit_log, get_recent_commits};
pub use merge::{get_current_branch, get_original_branch};
pub use merge_ops::{
    check_merge_conflicts, force_delete_branch, is_branch_merged, parse_conflict_files,
};
pub use pty::{commit_streaming, push_args, push_streaming};
pub use pty_input::SensitiveInput;
pub(crate) use stash::commit_diff::untracked_parent as stash_untracked_parent;
pub use stash::{apply_stash, drop_stash, list_stashes, pop_stash, push_stash};
pub use worktree_health::{
    canonical_dir, get_worktree_info, is_live_worktree, live_worktree_root,
    registered_worktree_for_feature_path, WorktreeRoots,
};
pub use worktree_ops::{
    create_worktree, has_uncommitted_changes, list_local_branches, list_worktree_branches,
    list_worktrees,
};
pub use worktree_removal::{remove_worktree, require_registered_worktree};
