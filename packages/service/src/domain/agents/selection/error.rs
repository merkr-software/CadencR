#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SelectionError {
    /// The provider resolved fine but exposes no usable model. Surfaced to the
    /// user instead of inventing a plausible model id that would fail later at
    /// session start with an opaque runtime error.
    #[error("provider '{provider_id}' exposes no models; check that its CLI is installed and authenticated")]
    NoModelAvailable { provider_id: String },
    /// A settings level could not be read. Starting on a fallback would run an
    /// agent the user did not pick, so the read failure is the answer.
    #[error("could not read the saved agent selection: {0}")]
    SettingsUnreadable(String),
}

impl SelectionError {
    /// Stable wire code for the WebSocket error reply.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoModelAvailable { .. } => "NO_MODEL_AVAILABLE",
            Self::SettingsUnreadable(_) => {
                crate::domain::settings_store::file::SETTINGS_READ_FAILED
            }
        }
    }
}

/// A settings level that cannot be read is not a malformed request: it gets its
/// own code, and a 4xx status so the cause reaches the user, who can fix it.
impl From<SelectionError> for crate::error::AppError {
    fn from(error: SelectionError) -> Self {
        match error {
            SelectionError::SettingsUnreadable(_) => Self::coded(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                error.code(),
                error.to_string(),
            ),
            SelectionError::NoModelAvailable { .. } => Self::BadRequest(error.to_string()),
        }
    }
}

impl From<crate::error::AppError> for SelectionError {
    fn from(error: crate::error::AppError) -> Self {
        Self::SettingsUnreadable(error.to_string())
    }
}
