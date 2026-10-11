use std::path::PathBuf;

/// Stable descriptor rejection categories shared by the service and CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionCode {
    DescriptorUnreadable,
    DescriptorInvalidJson,
    UnsupportedSchemaVersion,
    DescriptorSchemaViolation,
    DescriptorIdentityMismatch,
    DuplicateProviderId,
    UnsupportedDistribution,
    InvalidExecutablePath,
    ManagedStateInvalid,
}

impl RejectionCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DescriptorUnreadable => "DESCRIPTOR_UNREADABLE",
            Self::DescriptorInvalidJson => "DESCRIPTOR_INVALID_JSON",
            Self::UnsupportedSchemaVersion => "UNSUPPORTED_SCHEMA_VERSION",
            Self::DescriptorSchemaViolation => "DESCRIPTOR_SCHEMA_VIOLATION",
            Self::DescriptorIdentityMismatch => "DESCRIPTOR_IDENTITY_MISMATCH",
            Self::DuplicateProviderId => "DUPLICATE_PROVIDER_ID",
            Self::UnsupportedDistribution => "UNSUPPORTED_DISTRIBUTION",
            Self::InvalidExecutablePath => "INVALID_EXECUTABLE_PATH",
            Self::ManagedStateInvalid => "MANAGED_STATE_INVALID",
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct DescriptorError {
    pub code: RejectionCode,
    pub message: String,
}

impl DescriptorError {
    pub fn new(code: RejectionCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Read-only local provider-workspace validation failure.
#[derive(Debug, thiserror::Error)]
pub enum PluginValidationError {
    #[error("provider workspace {path:?} is not a readable directory: {source}")]
    WorkspaceUnreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("host descriptor {path:?} must be a regular file no larger than 1 MiB")]
    DescriptorNotRegular { path: PathBuf },
    #[error("could not read host descriptor {path:?}: {source}")]
    DescriptorUnreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid host descriptor JSON: {0}")]
    DescriptorInvalidJson(serde_json::Error),
    #[error("host descriptor is invalid: {0}")]
    DescriptorInvalid(DescriptorError),
    #[error("host descriptor filename must be {expected:?}")]
    DescriptorIdentityMismatch { expected: String },
    #[error("workspace marker must be a regular file no larger than 1 KiB")]
    MarkerNotRegular,
    #[error("could not read workspace marker: {0}")]
    MarkerUnreadable(std::io::Error),
    #[error("workspace marker does not match provider id {provider_id:?}")]
    WorkspaceIdentityMismatch { provider_id: String },
    #[error("host descriptor executable must target {expected:?}")]
    ExecutableBindingMismatch { expected: PathBuf },
    #[error(
        "provider executable {path:?} is missing, unreadable, or escapes the workspace: {detail}"
    )]
    ExecutableInvalid { path: PathBuf, detail: String },
    #[error("provider executable {path:?} is not executable")]
    ExecutableNotExecutable { path: PathBuf },
}

impl PluginValidationError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::WorkspaceUnreadable { .. } => "PLUGIN_WORKSPACE_UNREADABLE",
            Self::DescriptorNotRegular { .. } | Self::DescriptorUnreadable { .. } => {
                "DESCRIPTOR_UNREADABLE"
            }
            Self::DescriptorInvalidJson(_) => "DESCRIPTOR_INVALID_JSON",
            Self::DescriptorInvalid(error) => error.code.as_str(),
            Self::DescriptorIdentityMismatch { .. } | Self::WorkspaceIdentityMismatch { .. } => {
                "DESCRIPTOR_IDENTITY_MISMATCH"
            }
            Self::MarkerNotRegular | Self::MarkerUnreadable(_) => "PLUGIN_WORKSPACE_MARKER_INVALID",
            Self::ExecutableBindingMismatch { .. } | Self::ExecutableInvalid { .. } => {
                "INVALID_EXECUTABLE_PATH"
            }
            Self::ExecutableNotExecutable { .. } => "EXECUTABLE_NOT_EXECUTABLE",
        }
    }
}
