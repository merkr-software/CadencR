//! The service's integration tests, linked into ONE test binary.
//!
//! Every `tests/*.rs` file is its own crate that relinks the whole
//! `cadencr_service` rlib, so new suites belong here as a module rather than
//! as a new top-level file. Only tests that mutate process-global state keep
//! their own binary — see `tests/global_settings/`, `tests/home_env/` and the
//! remaining top-level `tests/*_test.rs` files for why each one is separate.

#[path = "../common/mod.rs"]
mod common;
#[path = "../support/mod.rs"]
mod support;

mod api;
mod db_coexistence;
mod editor_search;
mod editor_tree;
mod feature_create;
mod git_branch_cleanup;
mod git_status;
mod mcp_control_model_validation;
mod mcp_control_runtime;
mod mcp_spawn;
mod message_content_revision_migration;
mod migration_versions;
mod project_mcp_compare;
mod project_mcp_links;
mod project_mcp_tail;
mod project_mcp_tools;
mod project_mcp_worktree;
mod remote_auth;
mod remote_listener;
