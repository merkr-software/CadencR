use crate::error::AppError;

#[derive(Debug, Clone, thiserror::Error)]
pub enum SelectionError {
    /// The provider resolved fine but exposes no usable model. Surfaced to the
    /// user instead of inventing a plausible model id that would fail later at
    /// session start with an opaque runtime error.
    #[error("provider '{provider_id}' exposes no models; check that its CLI is installed and authenticated")]
    NoModelAvailable { provider_id: String },
    /// Preserve the original status and code of a failed settings lookup.
    #[error(transparent)]
    Settings(#[from] AppError),
}

impl SelectionError {
    /// Stable wire code for the WebSocket error reply.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoModelAvailable { .. } => "NO_MODEL_AVAILABLE",
            Self::Settings(error) => error.code(),
        }
    }
}

impl From<SelectionError> for AppError {
    fn from(error: SelectionError) -> Self {
        match error {
            SelectionError::Settings(error) => error,
            SelectionError::NoModelAvailable { .. } => Self::BadRequest(error.to_string()),
        }
    }
}
