//! Generic Agent Client Protocol (ACP) stdio JSON-RPC transport.
//!
//! Provider-neutral subprocess client. Mirrors the reliability shape of the
//! Codex app-server SDK (bounded line reads, pending-request guard, broadcast
//! channel for events, atomic exit-once flag, separate stderr reader, per-
//! request timeouts) but speaks plain ACP framing — no Codex-specific
//! method names or shapes leak into this module.
//!
//! Used by the OpenCode ACP adapter today and intended to be reused by
//! future ACP-based providers (Zed-style, Gemini, Kiro, ...). Adapters
//! supply a `tokio::process::Command` and translate `AcpEvent` variants
//! into `RuntimeEvent` for the unified runtime layer.

pub mod client;
mod client_spawn;
pub mod error;
pub mod incoming;
pub(crate) mod process_tree;
pub mod runtime;
pub mod types;

pub use client::{AcpClient, AcpSpawnOptions, AcpStderrPolicy};
pub use error::AcpError;
pub use process_tree::{AcpProcessTreeLimits, AcpProcessTreePolicy};
pub use types::{AcpClientInfo, AcpEvent};
