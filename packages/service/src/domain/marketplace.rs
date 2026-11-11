//! What every managed extension kind (themes, custom tabs, LSP servers,
//! providers) shares to install from the marketplace: the signed mixed
//! catalog and its verified cache, guarded downloads, private on-disk
//! storage and the signed revocation feeds. Each kind keeps its own
//! installer, receipts and policy decisions next to it
//! (`themes/managed`, `plugin_tabs/managed`, `lsp/managed`,
//! `agents/providers/installed/managed`).
pub mod catalog;
mod download;
mod kind;
pub mod models;
pub(crate) mod policy_feed;
pub mod revocation;
pub mod storage;
pub mod trust;
pub(crate) mod verified;

use crate::error::AppError;

pub use kind::ExtensionKind;

/// An error about the shared catalog, its downloads or its feeds, which no
/// single extension kind owns. Wrapping one of these errors again keeps a
/// single "marketplace" prefix.
pub fn invalid(message: impl std::fmt::Display) -> AppError {
    const PREFIX: &str = "marketplace ";
    let message = message.to_string();
    let message = if message.starts_with(PREFIX) {
        message
    } else {
        format!("{PREFIX}{message}")
    };
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "MARKETPLACE_CATALOG_INVALID",
        message,
    )
}
