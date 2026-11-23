//! Discovery of TCP ports allocated by a feature's own processes.
//!
//! A dev server started by an agent or typed into a feature terminal is
//! otherwise invisible until you read the whole conversation or hunt through
//! shells. This domain answers "which ports does this conversation currently
//! hold?" by walking the live process tree and attributing every listening
//! socket back to the feature that owns it — by the terminal or agent it
//! descends from, or failing that by the worktree it runs in, which is all
//! that survives once the agent that started the server has exited.

pub mod attribution;
pub mod cache;
pub mod models;
pub(crate) mod provider_processes;
pub mod repository;
pub mod routes;
pub mod scan;
pub mod service;
