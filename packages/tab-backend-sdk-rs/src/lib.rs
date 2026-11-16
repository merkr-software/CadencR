//! Write the native backend of a [Cadencr](https://github.com/merkr-software/CadencR)
//! custom tab.
//!
//! A custom tab may ship a native executable that Cadencr starts per
//! conversation and talks to over stdin/stdout, one JSON object per line.
//! The protocol is the contract — see [`docs/TAB_BACKEND_PROTOCOL.md`][doc] —
//! and this crate is one way to implement it:
//!
//! ```no_run
//! use std::process::ExitCode;
//!
//! use cadencr_tab_backend::{serve, Context, Error};
//! use serde_json::{json, Value};
//!
//! fn handle(cx: &Context) -> Result<Value, Error> {
//!     match cx.method() {
//!         "greet" => {
//!             let name: String = cx.params()?;
//!             Ok(json!(format!("hello, {name}")))
//!         }
//!         other => Err(Error::unknown_method(other)),
//!     }
//! }
//!
//! fn main() -> ExitCode {
//!     serve(handle)
//! }
//! ```
//!
//! [`serve`] reads and checks the `hello`, answers `ready`, then runs each
//! request on a small worker pool (a slow request does not hold up the
//! others; responses may be written out of order), turns a handler panic into
//! an [`codes::INTERNAL_ERROR`] response, logs and skips malformed lines, and
//! returns once stdin closes. On Unix it also reserves stdin and stdout for
//! the protocol: anything else printed to stdout goes to stderr, the log,
//! and child processes see `/dev/null` as stdin.
//!
//! Features: `api` adds a blocking client for the Cadencr API
//! ([`Context::api`]); `conformance` adds [`conformance::run`], which checks
//! any backend binary against the protocol. [`testing`] drives a handler
//! in-process.
//!
//! [doc]: https://github.com/merkr-software/CadencR/blob/main/docs/TAB_BACKEND_PROTOCOL.md

#[cfg(feature = "api")]
pub mod api;
#[cfg(feature = "conformance")]
pub mod conformance;
mod context;
mod error;
mod framing;
mod incoming;
pub mod protocol;
mod server;
mod stdio_guard;
pub mod testing;

pub use context::{Context, Handler};
pub use error::{codes, Error};
pub use protocol::PROTOCOL_VERSION;
pub use server::{serve, serve_with, Config, ServeError, SDK};
