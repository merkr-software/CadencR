//! Cadencr provider connector for the Cursor Agent CLI.
//!
//! `models` reads Cursor's account catalog (plus the mode and access selects),
//! `host-integration` declares compaction, worktree and resume conventions,
//! `slash-commands` rebuilds Cursor's `/` catalog from the filesystem;
//! `run --protocol acp-v1` proxies
//! ACP between Cadencr and `agent acp`, translating Cursor's model companions,
//! access modes, tool names and `cursor/*` extensions into standard ACP.

mod access;
mod cli;
mod config_view;
mod extensions;
mod host_integration;
mod model_config;
mod modes;
mod normalize;
mod permission_policy;
mod provider;
mod proxy;
mod slash_commands;
mod tool_calls;

fn main() -> std::process::ExitCode {
    cadencr_provider_sdk::run_cli(&provider::CursorProvider)
}
