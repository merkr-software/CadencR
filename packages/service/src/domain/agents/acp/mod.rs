//! Generic Agent Client Protocol (ACP) stdio JSON-RPC transport.
//!
//! Provider-neutral subprocess client built on the official ACP Rust SDK
//! (which owns stdout framing and request/response routing). Cadencr adds an
//! ordered, lossless event queue for the runtime (`event_hub`, adapted from
//! the Codex app-server SDK: overflow is a terminal visible error, never a
//! silent skip) beside a best-effort broadcast for probes, an exit-once
//! reaper, a bounded stderr reader, and per-request deadlines where the
//! method has one (`session/prompt` has none: it settles when the transport
//! closes). No Codex-specific method names or shapes leak into this module.
//!
//! Used by the OpenCode ACP adapter today and intended to be reused by
//! future ACP-based providers (Zed-style, Gemini, Kiro, ...). Adapters
//! supply a `tokio::process::Command` and translate `AcpEvent` variants
//! into `RuntimeEvent` for the unified runtime layer.

pub mod client;
mod client_dispatch;
mod client_spawn;
pub mod error;
pub mod event_hub;
pub mod incoming;
pub(crate) mod process_tree;
pub mod runtime;
pub mod types;

pub use client::{AcpClient, AcpSpawnOptions, AcpStderrPolicy};
pub use error::AcpError;
pub use process_tree::{AcpProcessTreeLimits, AcpProcessTreePolicy};
pub use types::{AcpClientInfo, AcpEvent};
