//! Stable author-publication diagnostics, independent of the desktop service.
use reqwest::StatusCode;

#[derive(Debug)]
pub enum Error {
    BadRequest(String),
    Internal(String),
    Coded {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
}

impl Error {
    pub(super) fn coded(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self::Coded {
            status,
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) => write!(formatter, "Bad request: {message}"),
            Self::Internal(message) => write!(formatter, "Internal error: {message}"),
            Self::Coded { message, .. } => formatter.write_str(message),
        }
    }
}
impl std::error::Error for Error {}
