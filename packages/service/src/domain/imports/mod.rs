//! Provider-neutral facade for importing existing conversations from external
//! AI providers (Claude Code today; Codex/OpenCode planned). The HTTP surface
//! is `domain::imports::routes`; provider-specific parsing lives in submodules
//! like `claude_code_jsonl` so generic code only ever deals with the
//! provider-neutral `ImportedConversation` type.

mod block_extract;
pub mod claude_code_jsonl;
mod codex_rollout;
pub(crate) use codex_rollout::{
    codex_sessions_dir, list_rollout_files as list_codex_rollout_files,
};
pub mod jobs;
pub mod models;
mod opencode_sqlite;
mod persistence;
pub mod refresh;
mod refresh_diff;
pub mod routes;
pub mod service;
pub mod types;
