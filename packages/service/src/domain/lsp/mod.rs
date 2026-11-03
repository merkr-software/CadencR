//! On-demand Language Server Protocol host.
//!
//! The renderer connects a [`@codemirror/lsp-client`] over a WebSocket; this
//! module spawns the appropriate language server as a child process, frames
//! `Content-Length`-prefixed JSON-RPC on its stdio, and proxies it 1:1 to the
//! WebSocket. The transport intentionally carries *raw LSP JSON-RPC text
//! frames* — not Cadencr's envelope format — so the renderer-side
//! `Transport` implementation can stay a thin shim over [LSP 3.17].
//!
//! Signed marketplace installation is explicit. Session startup resolves only
//! installed servers; immutable revisions preserve active lazy imports.
//!
//! [`@codemirror/lsp-client`]: https://code.haverbeke.berlin/codemirror/lsp-client
//! [LSP 3.17]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/

pub mod catalog;
pub mod framing;
mod legacy;
pub mod lifecycle;
pub mod managed;
pub mod marketplace_routes;
pub mod probe;
pub mod proxy;
pub mod registry;
pub mod root;
pub mod routes;
pub mod selection;
pub mod spawn;

pub use registry::LspRegistry;
pub use routes::lsp_router;
