use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable reason a managed index or package was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedContractErrorCode {
    UnsupportedSchemaVersion,
    InvalidSignatureEnvelope,
    InvalidPortableEntry,
    InvalidPackageVersion,
    InvalidHostMetadata,
    InvalidCompatibilityBounds,
    IncompatibleAppVersion,
    EntriesNotDeterministic,
    PackageNotFound,
    UnsupportedPlatform,
    UnsupportedDistribution,
    ChecksumRequired,
    InvalidPackagePath,
    CredentialDataForbidden,
}

impl ManagedContractErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedSchemaVersion => "MANAGED_SCHEMA_VERSION_UNSUPPORTED",
            Self::InvalidSignatureEnvelope => "MANAGED_SIGNATURE_ENVELOPE_INVALID",
            Self::InvalidPortableEntry => "MANAGED_PORTABLE_ENTRY_INVALID",
            Self::InvalidPackageVersion => "MANAGED_VERSION_INVALID",
            Self::InvalidHostMetadata => "MANAGED_HOST_METADATA_INVALID",
            Self::InvalidCompatibilityBounds => "MANAGED_COMPATIBILITY_INVALID",
            Self::IncompatibleAppVersion => "MANAGED_APP_VERSION_INCOMPATIBLE",
            Self::EntriesNotDeterministic => "MANAGED_INDEX_NONDETERMINISTIC",
            Self::PackageNotFound => "MANAGED_PACKAGE_NOT_FOUND",
            Self::UnsupportedPlatform => "MANAGED_PLATFORM_UNSUPPORTED",
            Self::UnsupportedDistribution => "MANAGED_DISTRIBUTION_UNSUPPORTED",
            Self::ChecksumRequired => "MANAGED_CHECKSUM_REQUIRED",
            Self::InvalidPackagePath => "MANAGED_PACKAGE_PATH_INVALID",
            Self::CredentialDataForbidden => "MANAGED_CREDENTIAL_DATA_FORBIDDEN",
        }
    }
}

/// Validation error for the signed managed-provider contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedContractError {
    pub code: ManagedContractErrorCode,
    pub message: String,
}

impl ManagedContractError {
    pub(super) fn new(code: ManagedContractErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ManagedContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ManagedContractError {}
