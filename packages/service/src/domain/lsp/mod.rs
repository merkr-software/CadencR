//! On-demand Language Server Protocol host.
//!
//! The renderer connects a [`@codemirror/lsp-client`] over a WebSocket; this
//! module spawns the appropriate language server as a child process, frames
//! `Content-Length`-prefixed JSON-RPC on its stdio, and proxies it 1:1 to the
//! WebSocket. The transport intentionally carries *raw LSP JSON-RPC text
//! frames* — not Cadencr's envelope format — so the renderer-side
//! `Transport` implementation can stay a thin shim over [LSP 3.17].
//!
//! Step 1 (this module's first commit) covers a hardcoded
//! `typescript-language-server --stdio` to prove the round-trip. Catalog +
//! `$PATH` detection lands in step 3; on-demand download in step 4;
//! reference counting, idle shutdown and crash backoff in step 5.
//!
//! [`@codemirror/lsp-client`]: https://code.haverbeke.berlin/codemirror/lsp-client
//! [LSP 3.17]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/

pub mod catalog;
pub mod checksum;
pub mod downloader;
pub mod framing;
pub mod lifecycle;
pub mod npm_installer;
pub mod platform;
pub mod probe;
pub mod proxy;
pub mod registry;
pub mod root;
pub mod routes;
pub mod spawn;

pub use registry::LspRegistry;
pub use routes::lsp_router;
