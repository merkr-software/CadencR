//! The error a handler returns, sent to the caller as `{code, message}`.

use std::fmt;

use crate::protocol::ErrorBody;

/// Error codes this crate sends on its own. The protocol reserves them: a
/// backend should use them only with the meaning given here.
pub mod codes {
    /// No method of that name.
    pub const UNKNOWN_METHOD: &str = "UNKNOWN_METHOD";
    /// The params do not fit the method.
    pub const INVALID_PARAMS: &str = "INVALID_PARAMS";
    /// A line with an id that is not a well-formed request.
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    /// The handler failed unexpectedly (for example it panicked).
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
    /// The result does not fit in one line of
    /// [`MAX_LINE_BYTES`](crate::protocol::MAX_LINE_BYTES).
    pub const RESPONSE_TOO_LARGE: &str = "RESPONSE_TOO_LARGE";
    /// Too many requests are already waiting for a worker; retry later.
    pub const BUSY: &str = "BUSY";
}

/// A failed request: a stable `SCREAMING_SNAKE_CASE` code and a message for
/// a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    code: String,
    message: String,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    /// [`codes::UNKNOWN_METHOD`] for `method`.
    pub fn unknown_method(method: &str) -> Self {
        Self::new(codes::UNKNOWN_METHOD, format!("unknown method `{method}`"))
    }

    /// [`codes::INVALID_PARAMS`] with what is wrong.
    pub fn invalid_params(detail: impl fmt::Display) -> Self {
        Self::new(codes::INVALID_PARAMS, format!("invalid params: {detail}"))
    }

    /// [`codes::INTERNAL_ERROR`] with what went wrong.
    pub fn internal(detail: impl fmt::Display) -> Self {
        Self::new(codes::INTERNAL_ERROR, detail.to_string())
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

impl From<Error> for ErrorBody {
    fn from(error: Error) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructors_use_the_reserved_codes() {
        assert_eq!(Error::unknown_method("x").code(), codes::UNKNOWN_METHOD);
        assert_eq!(
            Error::invalid_params("bad").message(),
            "invalid params: bad"
        );
        let body = ErrorBody::from(Error::new("MINE", "m"));
        assert_eq!((body.code.as_str(), body.message.as_str()), ("MINE", "m"));
    }
}
