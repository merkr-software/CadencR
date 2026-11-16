//! Provider version detection and updates.
//!
//! Every registered provider may carry a [`ProviderUpdater`] in its
//! registration metadata. Built-ins use [`native_cli::NativeCliUpdater`]
//! (installed CLI version + a published release source + the CLI's own
//! upgrade command); installed connectors use the optional `updates` /
//! `update` executable commands (`docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md`).
//! Shared code — the cached status service, the HTTP routes, the settings UI —
//! only sees this trait and never branches on a provider id.

pub(crate) mod native_cli;
pub(crate) mod npm;
pub mod routes;
mod service;
mod types;
pub(crate) mod version;

use std::time::Duration;

use async_trait::async_trait;

pub use service::ProviderUpdateService;
pub use types::{
    ProviderUpdateActivity, ProviderUpdateEvent, ProviderUpdateOutcome, ProviderUpdateRequest,
    ProviderUpdateState, ProviderUpdateStatus, ProviderUpdatesResponse,
};

/// Upper bound for one upgrade run, connector or native installer.
pub(crate) const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Longest updater text shown to the user (summary or failure output).
const MAX_MESSAGE_CHARS: usize = 600;

/// Program output made safe to display: ANSI sequences and control characters
/// removed, trimmed, and capped to its last characters — installers print the
/// cause of a failure last.
pub(crate) fn display_tail(text: &str) -> String {
    let plain: String = strip_ansi(text)
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let plain = plain.trim();
    let count = plain.chars().count();
    if count <= MAX_MESSAGE_CHARS {
        return plain.to_string();
    }
    let tail: String = plain.chars().skip(count - MAX_MESSAGE_CHARS).collect();
    format!("…{tail}")
}

fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        result.push(ch);
    }
    result
}

/// What one version check found. Version strings are display values; the
/// updater decides ordering when it reports `latest_version`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderVersionReport {
    /// Installed version. `None` means the provider's CLI is not installed.
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    /// Installable versions, newest first.
    pub available_versions: Vec<String>,
    /// Whether `latest_version` should be offered over `current_version`.
    /// The updater owns version ordering, so shared code never compares.
    pub update_available: bool,
    /// Whether [`ProviderUpdater::update`] accepts an explicit target version.
    pub supports_target_version: bool,
    /// The installed version was read but the release lookup failed.
    pub check_error: Option<String>,
}

/// Shared resources handed to updaters on each call.
#[derive(Clone, Debug)]
pub struct UpdateContext {
    pub read_pool: sqlx::SqlitePool,
    pub http: reqwest::Client,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    /// The provider does not manage updates (e.g. a connector without the
    /// optional commands). Rendered as "not supported", never as a failure.
    Unsupported,
    Failed(String),
}

impl UpdateError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => formatter.write_str("updates are not supported by this provider"),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

/// Provider-owned version detection and upgrade.
#[async_trait]
pub trait ProviderUpdater: Send + Sync + std::fmt::Debug {
    async fn check(&self, context: &UpdateContext) -> Result<ProviderVersionReport, UpdateError>;

    /// Install `target`, or the latest version when `None`. Returns an
    /// optional human-readable summary of what happened.
    async fn update(
        &self,
        context: &UpdateContext,
        target: Option<&str>,
    ) -> Result<Option<String>, UpdateError>;
}

#[cfg(test)]
mod tests {
    use super::{display_tail, MAX_MESSAGE_CHARS};

    #[test]
    fn display_text_is_plain_and_bounded() {
        assert_eq!(display_tail("\u{1b}[32mok\u{1b}[0m\ndone\n"), "ok done");
        let tail = display_tail(&"x".repeat(MAX_MESSAGE_CHARS + 50));
        assert!(tail.starts_with('…'));
        assert_eq!(tail.chars().count(), MAX_MESSAGE_CHARS + 1);
    }
}
