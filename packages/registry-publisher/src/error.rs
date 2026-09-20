use std::fmt;

/// Sanitized publication failure suitable for CLI display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublisherError {
    message: String,
}

impl PublisherError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub(crate) fn io(context: &str, _error: impl fmt::Display) -> Self {
        Self::new(format!("{context} failed"))
    }

    pub(crate) fn cleanup(primary: Self, failures: usize) -> Self {
        Self::new(format!(
            "{}; staging cleanup also failed ({failures} operation(s))",
            primary.message
        ))
    }
}

impl fmt::Display for PublisherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PublisherError {}

impl From<cadencr_registry_core::RegistryError> for PublisherError {
    fn from(error: cadencr_registry_core::RegistryError) -> Self {
        // Registry diagnostics are already intended for operator-facing CLI output.
        Self::new(error.to_string())
    }
}
