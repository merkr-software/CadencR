//! Provider data that follows a project folder to its new place.
//!
//! Agent CLIs file some of their state under the absolute path a session ran
//! in (Claude Code's transcripts and memory under `projects/<encoded path>`,
//! its per-folder entries in `.claude.json`; Codex's per-folder trust in
//! `config.toml`). When a project folder is renamed
//! or moved, the provider that owns such state carries it across; providers
//! that re-home a session by themselves on resume (OpenCode, see
//! `opencode::acp::session_location`) or that key nothing by path register no
//! relocator. Shared code only sees this trait.

use std::path::{Path, PathBuf};

use async_trait::async_trait;

/// A project folder that moved: everything under `from` now lives under `to`.
#[derive(Debug, Clone, Copy)]
pub struct FolderMove<'a> {
    pub from: &'a Path,
    pub to: &'a Path,
    /// Conversation folders that moved along, at their old place: the
    /// worktrees kept inside the project folder.
    pub inner: &'a [PathBuf],
}

impl FolderMove<'_> {
    /// Every conversation folder that moved, as `(old, new)`: the project
    /// folder itself, then the [`Self::inner`] ones.
    pub fn folders(&self) -> Vec<(PathBuf, PathBuf)> {
        std::iter::once(self.from.to_path_buf())
            .chain(self.inner.iter().cloned())
            .filter_map(|old| {
                let new = crate::shared::path_rebase::rebase(&old, self.from, self.to)?;
                Some((old, new))
            })
            .collect()
    }
}

#[async_trait]
pub trait ProviderRelocator: Send + Sync + std::fmt::Debug {
    /// Carry the provider's path-keyed state from `moved.from` to `moved.to`.
    /// Runs after the folder moved. Returns what could not be carried, for
    /// the user; an `Err` is a failure worth reporting as such.
    async fn relocate(&self, moved: FolderMove<'_>) -> Result<Vec<String>, String>;
}
