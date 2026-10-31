//! Structured `plugin.json` findings with stable codes: add new ones, never
//! rename.

use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PluginIssueCode {
    ManifestUnreadable,
    ManifestInvalidJson,
    SchemaVersionUnsupported,
    KindInvalid,
    IdInvalid,
    NameInvalid,
    VersionInvalid,
    DescriptionInvalid,
    MembersCountInvalid,
    MemberKindInvalid,
    MemberPathInvalid,
    MemberPathDuplicate,
    MemberPathNested,
    MemberFolderInvalid,
    MemberDescriptorRequired,
    MemberDescriptorUnexpected,
    MemberDescriptorInvalid,
    MemberVersionMismatch,
    MemberIdCollision,
}

impl PluginIssueCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ManifestUnreadable => "MANIFEST_UNREADABLE",
            Self::ManifestInvalidJson => "MANIFEST_INVALID_JSON",
            Self::SchemaVersionUnsupported => "SCHEMA_VERSION_UNSUPPORTED",
            Self::KindInvalid => "KIND_INVALID",
            Self::IdInvalid => "ID_INVALID",
            Self::NameInvalid => "NAME_INVALID",
            Self::VersionInvalid => "VERSION_INVALID",
            Self::DescriptionInvalid => "DESCRIPTION_INVALID",
            Self::MembersCountInvalid => "MEMBERS_COUNT_INVALID",
            Self::MemberKindInvalid => "MEMBER_KIND_INVALID",
            Self::MemberPathInvalid => "MEMBER_PATH_INVALID",
            Self::MemberPathDuplicate => "MEMBER_PATH_DUPLICATE",
            Self::MemberPathNested => "MEMBER_PATH_NESTED",
            Self::MemberFolderInvalid => "MEMBER_FOLDER_INVALID",
            Self::MemberDescriptorRequired => "MEMBER_DESCRIPTOR_REQUIRED",
            Self::MemberDescriptorUnexpected => "MEMBER_DESCRIPTOR_UNEXPECTED",
            Self::MemberDescriptorInvalid => "MEMBER_DESCRIPTOR_INVALID",
            Self::MemberVersionMismatch => "MEMBER_VERSION_MISMATCH",
            Self::MemberIdCollision => "MEMBER_ID_COLLISION",
        }
    }
}

/// One finding. `field` is a dotted path into `plugin.json`
/// (`contributes[1].path`) or `None` for document-level problems.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PluginIssue {
    pub code: PluginIssueCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

impl PluginIssue {
    pub fn new(
        code: PluginIssueCode,
        field: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            field: Some(field.into()),
            message: message.into(),
        }
    }

    pub fn document(code: PluginIssueCode, message: impl Into<String>) -> Self {
        Self {
            code,
            field: None,
            message: message.into(),
        }
    }

    /// `[CODE] field: message`, or `[CODE] message` for a document-level issue.
    pub fn describe(&self) -> String {
        match &self.field {
            Some(field) => format!("[{}] {field}: {}", self.code.as_str(), self.message),
            None => format!("[{}] {}", self.code.as_str(), self.message),
        }
    }
}

/// `issues` described and joined with `; `, for one-line messages.
pub fn describe_all(issues: &[PluginIssue]) -> String {
    issues
        .iter()
        .map(PluginIssue::describe)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Everything validation found; a manifest is usable only with no `errors`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, ToSchema)]
pub struct PluginFindings {
    pub errors: Vec<PluginIssue>,
}

impl PluginFindings {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }

    /// Every error, described and joined with `; `.
    pub fn describe_errors(&self) -> String {
        describe_all(&self.errors)
    }

    pub(crate) fn error(
        &mut self,
        code: PluginIssueCode,
        field: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.errors.push(PluginIssue::new(code, field, message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialize_as_their_stable_strings() {
        for code in [
            PluginIssueCode::ManifestInvalidJson,
            PluginIssueCode::MemberPathNested,
            PluginIssueCode::MemberIdCollision,
        ] {
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::Value::String(code.as_str().into())
            );
        }
    }

    #[test]
    fn describe_names_code_and_field() {
        let issue = PluginIssue::new(PluginIssueCode::NameInvalid, "name", "empty");
        assert_eq!(issue.describe(), "[NAME_INVALID] name: empty");
        let document = PluginIssue::document(PluginIssueCode::ManifestUnreadable, "gone");
        assert_eq!(document.describe(), "[MANIFEST_UNREADABLE] gone");
        let mut findings = PluginFindings::default();
        assert!(findings.is_valid());
        findings.errors.extend([issue, document]);
        assert_eq!(
            findings.describe_errors(),
            "[NAME_INVALID] name: empty; [MANIFEST_UNREADABLE] gone"
        );
    }
}
