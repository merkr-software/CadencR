//! Cadencr connector for the native Antigravity CLI.

mod catalog;
mod cli;
mod config;
mod events;
mod mcp_inventory;
mod native_compat;
mod provider;
mod relay;
mod slash_commands;

fn main() -> std::process::ExitCode {
    cadencr_provider_sdk::run_cli(&provider::AntigravityProvider)
}
