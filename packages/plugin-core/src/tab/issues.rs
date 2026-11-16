//! Structured validation findings with stable codes.
//!
//! The service lists them beside each tab, the CLI prints them, and the
//! renderer may key copy off `code`, so codes are part of the contract: add new
//! ones, never rename.

use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TabIssueCode {
    ManifestUnreadable,
    ManifestInvalidJson,
    SchemaVersionUnsupported,
    KindInvalid,
    IdInvalid,
    IdReserved,
    IdMismatch,
    NameInvalid,
    VersionInvalid,
    DescriptionTooLong,
    LabelInvalid,
    ApiVersionUnsupported,
    PathInvalid,
    IconInvalid,
    IconMissing,
    PermissionUnknown,
    PermissionDuplicate,
    OriginInvalid,
    OriginDuplicate,
    OriginsTooMany,
    OriginInsecureLocalhost,
    NetworkReasoningRequired,
    ConfigTooMany,
    ConfigKeyInvalid,
    ConfigKeyDuplicate,
    ConfigLabelInvalid,
    ConfigOptionsRequired,
    ConfigOptionsUnexpected,
    ConfigOptionInvalid,
    ConfigSecretDefault,
    ConfigDefaultInvalid,
    CommandsTooMany,
    CommandInvalid,
    CommandDuplicate,
    CommandNotAllowed,
    CommandReasoningRequired,
    /// `backend.command`/`backend.args` (a launch line, possibly a script on
    /// `PATH`) were replaced by `protocol` + per-platform native `binary`.
    BackendCommandRemoved,
    BackendProtocolUnsupported,
    BackendBinaryRequired,
    BackendPlatformUnknown,
    BackendReasoningRequired,
    BackendUnavailable,
    ShortcutsTooMany,
    ShortcutIdInvalid,
    ShortcutIdDuplicate,
    ShortcutKeysInvalid,
    ShortcutKeysDuplicate,
    ShortcutDescriptionInvalid,
    ReplacesInvalid,
    ReplacesDuplicate,
}

impl TabIssueCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ManifestUnreadable => "MANIFEST_UNREADABLE",
            Self::ManifestInvalidJson => "MANIFEST_INVALID_JSON",
            Self::SchemaVersionUnsupported => "SCHEMA_VERSION_UNSUPPORTED",
            Self::KindInvalid => "KIND_INVALID",
            Self::IdInvalid => "ID_INVALID",
            Self::IdReserved => "ID_RESERVED",
            Self::IdMismatch => "ID_MISMATCH",
            Self::NameInvalid => "NAME_INVALID",
            Self::VersionInvalid => "VERSION_INVALID",
            Self::DescriptionTooLong => "DESCRIPTION_TOO_LONG",
            Self::LabelInvalid => "LABEL_INVALID",
            Self::ApiVersionUnsupported => "API_VERSION_UNSUPPORTED",
            Self::PathInvalid => "PATH_INVALID",
            Self::IconInvalid => "ICON_INVALID",
            Self::IconMissing => "ICON_MISSING",
            Self::PermissionUnknown => "PERMISSION_UNKNOWN",
            Self::PermissionDuplicate => "PERMISSION_DUPLICATE",
            Self::OriginInvalid => "ORIGIN_INVALID",
            Self::OriginDuplicate => "ORIGIN_DUPLICATE",
            Self::OriginsTooMany => "ORIGINS_TOO_MANY",
            Self::OriginInsecureLocalhost => "ORIGIN_INSECURE_LOCALHOST",
            Self::NetworkReasoningRequired => "NETWORK_REASONING_REQUIRED",
            Self::ConfigTooMany => "CONFIG_TOO_MANY",
            Self::ConfigKeyInvalid => "CONFIG_KEY_INVALID",
            Self::ConfigKeyDuplicate => "CONFIG_KEY_DUPLICATE",
            Self::ConfigLabelInvalid => "CONFIG_LABEL_INVALID",
            Self::ConfigOptionsRequired => "CONFIG_OPTIONS_REQUIRED",
            Self::ConfigOptionsUnexpected => "CONFIG_OPTIONS_UNEXPECTED",
            Self::ConfigOptionInvalid => "CONFIG_OPTION_INVALID",
            Self::ConfigSecretDefault => "CONFIG_SECRET_DEFAULT",
            Self::ConfigDefaultInvalid => "CONFIG_DEFAULT_INVALID",
            Self::CommandsTooMany => "COMMANDS_TOO_MANY",
            Self::CommandInvalid => "COMMAND_INVALID",
            Self::CommandDuplicate => "COMMAND_DUPLICATE",
            Self::CommandNotAllowed => "COMMAND_NOT_ALLOWED",
            Self::CommandReasoningRequired => "COMMAND_REASONING_REQUIRED",
            Self::BackendCommandRemoved => "BACKEND_COMMAND_REMOVED",
            Self::BackendProtocolUnsupported => "BACKEND_PROTOCOL_UNSUPPORTED",
            Self::BackendBinaryRequired => "BACKEND_BINARY_REQUIRED",
            Self::BackendPlatformUnknown => "BACKEND_PLATFORM_UNKNOWN",
            Self::BackendReasoningRequired => "BACKEND_REASONING_REQUIRED",
            Self::BackendUnavailable => "BACKEND_UNAVAILABLE",
            Self::ShortcutsTooMany => "SHORTCUTS_TOO_MANY",
            Self::ShortcutIdInvalid => "SHORTCUT_ID_INVALID",
            Self::ShortcutIdDuplicate => "SHORTCUT_ID_DUPLICATE",
            Self::ShortcutKeysInvalid => "SHORTCUT_KEYS_INVALID",
            Self::ShortcutKeysDuplicate => "SHORTCUT_KEYS_DUPLICATE",
            Self::ShortcutDescriptionInvalid => "SHORTCUT_DESCRIPTION_INVALID",
            Self::ReplacesInvalid => "REPLACES_INVALID",
            Self::ReplacesDuplicate => "REPLACES_DUPLICATE",
        }
    }
}

/// One finding. `field` is a dotted path into the manifest (`network.allowed_origins[0]`)
/// or `None` for document-level problems.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct TabIssue {
    pub code: TabIssueCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

impl TabIssue {
    pub fn new(code: TabIssueCode, field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            field: Some(field.into()),
            message: message.into(),
        }
    }

    pub fn document(code: TabIssueCode, message: impl Into<String>) -> Self {
        Self {
            code,
            field: None,
            message: message.into(),
        }
    }

    /// `field: message`, or the bare message for a document-level issue.
    pub fn describe(&self) -> String {
        match &self.field {
            Some(field) => format!("[{}] {field}: {}", self.code.as_str(), self.message),
            None => format!("[{}] {}", self.code.as_str(), self.message),
        }
    }
}

/// `issues` described and joined with `; `, for one-line messages.
pub fn describe_all(issues: &[TabIssue]) -> String {
    issues
        .iter()
        .map(TabIssue::describe)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Everything validation found. A manifest is usable only with no `errors`;
/// `warnings` never block enabling.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, ToSchema)]
pub struct TabFindings {
    pub errors: Vec<TabIssue>,
    pub warnings: Vec<TabIssue>,
}

impl TabFindings {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }

    /// Every error, described and joined with `; `.
    pub fn describe_errors(&self) -> String {
        describe_all(&self.errors)
    }

    pub(crate) fn error(
        &mut self,
        code: TabIssueCode,
        field: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.errors.push(TabIssue::new(code, field, message));
    }

    pub(crate) fn warning(
        &mut self,
        code: TabIssueCode,
        field: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.warnings.push(TabIssue::new(code, field, message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialize_as_their_stable_strings() {
        for code in [
            TabIssueCode::ManifestInvalidJson,
            TabIssueCode::OriginInsecureLocalhost,
            TabIssueCode::ConfigSecretDefault,
        ] {
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::Value::String(code.as_str().into())
            );
        }
    }

    #[test]
    fn describe_names_code_and_field() {
        let issue = TabIssue::new(TabIssueCode::NameInvalid, "name", "too long");
        assert_eq!(issue.describe(), "[NAME_INVALID] name: too long");
        let document = TabIssue::document(TabIssueCode::ManifestUnreadable, "gone");
        assert_eq!(document.describe(), "[MANIFEST_UNREADABLE] gone");
    }
}
