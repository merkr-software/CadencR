//! The extension kinds a catalog entry can be, and how shared code names
//! them in errors.
use crate::error::AppError;
use axum::http::StatusCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionKind {
    Theme,
    Tab,
    Lsp,
    Provider,
}

impl ExtensionKind {
    /// The kind named by a catalog entry's `kind` field.
    pub fn from_catalog(kind: &str) -> Option<Self> {
        match kind {
            "theme" => Some(Self::Theme),
            "tab" => Some(Self::Tab),
            "lsp" => Some(Self::Lsp),
            "provider" => Some(Self::Provider),
            _ => None,
        }
    }

    /// What users call it: `"custom tab"`.
    pub fn noun(self) -> &'static str {
        match self {
            Self::Theme => "theme",
            Self::Tab => "custom tab",
            Self::Lsp => "LSP server",
            Self::Provider => "provider",
        }
    }

    /// The kind's own "invalid package" error, as its installer reports it.
    pub fn invalid(self, message: impl std::fmt::Display) -> AppError {
        let (status, code) = match self {
            Self::Theme => (StatusCode::BAD_REQUEST, "MANAGED_THEME_INVALID"),
            Self::Tab => (StatusCode::BAD_REQUEST, "MANAGED_TAB_INVALID"),
            Self::Lsp => (StatusCode::UNPROCESSABLE_ENTITY, "LSP_PACKAGE_INVALID"),
            Self::Provider => (StatusCode::BAD_REQUEST, "MANAGED_PROVIDER_INVALID"),
        };
        AppError::coded(status, code, format!("{} {message}", self.noun()))
    }
}

/// An error about an entry of catalog kind `kind`; an unknown kind is a
/// catalog error.
pub(super) fn entry_invalid(kind: &str, message: impl std::fmt::Display) -> AppError {
    match ExtensionKind::from_catalog(kind) {
        Some(kind) => kind.invalid(message),
        None => super::invalid(format!("{kind} entry {message}")),
    }
}
