//! Stable, user-visible failure codes for locally installed provider
//! descriptors.
//!
//! Two outcomes are modelled separately because they mean different things to
//! the user:
//!
//! - a **rejection** means the descriptor never becomes a provider — its
//!   identity, schema, or launch policy could not be trusted, so registering it
//!   would put an unverified id into the catalog;
//! - a **quarantine** means the descriptor is valid and stays registered, but
//!   the install cannot run right now; the catalog shows it as unavailable with
//!   the reason attached rather than dropping it (`BOUNDARIES.md` Phase 8,
//!   "quarantine or clearly mark incompatible versions instead of crashing the
//!   provider catalog").
//!
//! Codes are SCREAMING_SNAKE and stable: they are part of what the desktop and
//! CLI surface to the user, so renaming one is a breaking change.

use std::path::{Path, PathBuf};

/// Why a descriptor was refused registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionCode {
    /// The file could not be read (permissions, disappeared mid-scan).
    DescriptorUnreadable,
    /// The file is not valid JSON.
    DescriptorInvalidJson,
    /// `schema_version` is not one this build understands.
    UnsupportedSchemaVersion,
    /// The payload does not satisfy the ACP Registry agent entry schema, or the
    /// Cadencr host envelope around it is malformed.
    DescriptorSchemaViolation,
    /// The file name and the agent entry's `id` disagree about which provider
    /// this install is.
    DescriptorIdentityMismatch,
    /// A provider with this id is already registered (a built-in, or an earlier
    /// descriptor). The first registration keeps the id.
    DuplicateProviderId,
    /// The descriptor relies on a distribution this build does not install.
    /// Only an explicitly selected local executable is supported today.
    UnsupportedDistribution,
    /// `installation.executable.command` is not usable as a launch target.
    InvalidExecutablePath,
    /// Managed desired state could not be reconciled to its derived descriptor.
    ManagedStateInvalid,
}

impl RejectionCode {
    pub fn as_str(self) -> &'static str {
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

/// Why a registered install cannot currently launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuarantineCode {
    /// The portable entry declares no distribution target for this OS/arch.
    IncompatiblePlatform,
    /// The resolved executable is not on disk.
    ExecutableNotFound,
    /// The resolved path could not be inspected at all — a directory on the way
    /// denies access, the path is malformed, or the filesystem errored. Kept
    /// distinct from "not found" so a permissions problem is not reported as a
    /// missing file, which sends the user looking for the wrong fix.
    ExecutableUnreadable,
    /// The resolved path exists but is not an executable file.
    ExecutableNotExecutable,
}

impl QuarantineCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IncompatiblePlatform => "INCOMPATIBLE_PLATFORM",
            Self::ExecutableNotFound => "EXECUTABLE_NOT_FOUND",
            Self::ExecutableUnreadable => "EXECUTABLE_UNREADABLE",
            Self::ExecutableNotExecutable => "EXECUTABLE_NOT_EXECUTABLE",
        }
    }
}

/// A descriptor that did not become a provider, kept so the reason stays
/// visible instead of living only in a startup log line.
#[derive(Debug, Clone)]
pub struct DescriptorRejection {
    pub source_path: PathBuf,
    /// The id the descriptor claimed, when it got far enough to claim one.
    pub provider_id: Option<String>,
    pub code: RejectionCode,
    pub message: String,
}

impl DescriptorRejection {
    pub fn new(source_path: &Path, code: RejectionCode, message: impl Into<String>) -> Self {
        Self {
            source_path: source_path.to_path_buf(),
            provider_id: None,
            code,
            message: message.into(),
        }
    }

    pub fn with_provider_id(mut self, provider_id: impl Into<String>) -> Self {
        self.provider_id = Some(provider_id.into());
        self
    }
}

/// A validation failure raised while parsing one descriptor. The loader turns
/// it into a [`DescriptorRejection`] once it knows which file produced it.
#[derive(Debug, Clone)]
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

#[cfg(test)]
mod tests {
    use super::{DescriptorError, DescriptorRejection, QuarantineCode, RejectionCode};
    use std::path::Path;

    /// The wire codes are a published contract; freeze the spelling.
    #[test]
    fn codes_are_stable_screaming_snake() {
        assert_eq!(
            RejectionCode::DescriptorIdentityMismatch.as_str(),
            "DESCRIPTOR_IDENTITY_MISMATCH"
        );
        assert_eq!(
            RejectionCode::DuplicateProviderId.as_str(),
            "DUPLICATE_PROVIDER_ID"
        );
        assert_eq!(
            RejectionCode::UnsupportedDistribution.as_str(),
            "UNSUPPORTED_DISTRIBUTION"
        );
        assert_eq!(
            QuarantineCode::ExecutableNotFound.as_str(),
            "EXECUTABLE_NOT_FOUND"
        );
        assert_eq!(
            QuarantineCode::ExecutableUnreadable.as_str(),
            "EXECUTABLE_UNREADABLE"
        );
        assert_eq!(
            QuarantineCode::ExecutableNotExecutable.as_str(),
            "EXECUTABLE_NOT_EXECUTABLE"
        );
        assert_eq!(
            QuarantineCode::IncompatiblePlatform.as_str(),
            "INCOMPATIBLE_PLATFORM"
        );
    }

    #[test]
    fn rejection_carries_the_claimed_provider_id_when_known() {
        let rejection = DescriptorRejection::new(
            Path::new("/providers/acme.json"),
            RejectionCode::DuplicateProviderId,
            "already registered",
        )
        .with_provider_id("acme");
        assert_eq!(rejection.provider_id.as_deref(), Some("acme"));
        assert_eq!(rejection.code, RejectionCode::DuplicateProviderId);

        let anonymous = DescriptorRejection::new(
            Path::new("/providers/acme.json"),
            RejectionCode::DescriptorInvalidJson,
            "bad json",
        );
        assert!(anonymous.provider_id.is_none());
    }

    #[test]
    fn descriptor_error_preserves_code_and_message() {
        let error = DescriptorError::new(RejectionCode::InvalidExecutablePath, "not absolute");
        assert_eq!(error.code, RejectionCode::InvalidExecutablePath);
        assert_eq!(error.message, "not absolute");
    }
}
