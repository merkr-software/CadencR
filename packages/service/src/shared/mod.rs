#![allow(clippy::single_match)]

pub mod app_paths;
pub mod atomic_file;
pub mod bounded_command;
pub mod capped_read;
pub mod db;
pub mod disk_space;
pub mod document_file;
pub mod env_file;
pub mod file_digest;
pub mod file_watch;
pub mod frontmatter;
pub mod fs_durability;
pub mod git_cli;
pub mod git_context;
pub mod http_relay;
pub mod image_file;
pub mod login_env;
pub mod login_shell;
pub mod markup;
pub mod migrate;
pub mod private_temp;
pub mod quarantine;
pub mod security;
pub mod setup_log;
pub mod slug;
pub mod ssh_env;
pub mod startup_progress;
pub mod terminal_shell;
#[cfg(test)]
pub mod test_env;
pub mod trash;
pub mod user_shell;
pub mod watch_limits;
pub mod worktree_paths;
