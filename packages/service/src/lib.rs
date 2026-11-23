// Every intentional discard of a fallible result is named (`shared::discard`)
// or carries an `#[expect]` with its reason; see `.claude/rules/error-handling.md`.
#![cfg_attr(
    not(test),
    deny(clippy::let_underscore_must_use, clippy::unused_result_ok)
)]

pub mod api;
pub mod app_state;
pub mod config;
pub mod dev_clone;
pub mod dev_env;
pub mod domain;
pub mod error;
pub mod remote;
pub mod shared;
pub mod shutdown;
pub mod startup;
pub mod startup_lock;
