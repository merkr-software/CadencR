//! The `plugin.json` document, exactly as an author writes it, and the rules
//! that need no filesystem.
//!
//! Every struct is closed (`deny_unknown_fields`): a key Cadencr does not
//! know is a typo or a feature that does not exist.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::issues::{PluginFindings, PluginIssueCode as Code};
use super::{
    MAX_DESCRIPTION_CHARS, MAX_ID_BYTES, MAX_MEMBERS, MAX_NAME_CHARS, SUPPORTED_SCHEMA_VERSION,
};

/// A multi-export plugin's author manifest (`<folder>/plugin.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub schema_version: u32,
    /// Always `"plugin"`.
    pub kind: String,
    pub id: String,
    pub name: String,
    /// The one version every member ships at.
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub contributes: Vec<PluginMember>,
}

/// One member: a complete single-kind folder inside the plugin folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginMember {
    /// `provider`, `theme`, `tab` or `lsp`.
    pub kind: String,
    /// The member folder, relative to the plugin folder.
    pub path: String,
    /// Provider members only: the host descriptor file, relative to the
    /// plugin folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<String>,
}

impl PluginMember {
    /// The member's kind, when it is one a plugin may contribute.
    pub fn member_kind(&self) -> Option<PluginMemberKind> {
        PluginMemberKind::parse(&self.kind)
    }
}

/// The single kinds a plugin may contribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PluginMemberKind {
    Provider,
    Theme,
    Tab,
    Lsp,
}

impl PluginMemberKind {
    pub const ALL: [Self; 4] = [Self::Provider, Self::Theme, Self::Tab, Self::Lsp];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Theme => "theme",
            Self::Tab => "tab",
            Self::Lsp => "lsp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

impl std::fmt::Display for PluginMemberKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Lowercase ASCII letters and digits in segments joined by single `-`, at
/// most [`MAX_ID_BYTES`] — the registry's plugin id grammar.
pub fn is_valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

/// Validate every manifest rule that does not need the folder.
pub fn validate_manifest(manifest: &PluginManifest) -> PluginFindings {
    let mut findings = PluginFindings::default();
    validate_identity(manifest, &mut findings);
    let count = manifest.contributes.len();
    if count == 0 || count > MAX_MEMBERS {
        findings.error(
            Code::MembersCountInvalid,
            "contributes",
            format!("must list 1 to {MAX_MEMBERS} members, found {count}"),
        );
    }
    for (index, member) in manifest.contributes.iter().enumerate() {
        validate_member(index, member, &mut findings);
    }
    validate_member_paths(&manifest.contributes, &mut findings);
    findings
}

fn validate_identity(manifest: &PluginManifest, findings: &mut PluginFindings) {
    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        findings.error(
            Code::SchemaVersionUnsupported,
            "schema_version",
            format!("must be {SUPPORTED_SCHEMA_VERSION}"),
        );
    }
    if manifest.kind != "plugin" {
        findings.error(Code::KindInvalid, "kind", "must be \"plugin\"");
    }
    if !is_valid_plugin_id(&manifest.id) {
        findings.error(
            Code::IdInvalid,
            "id",
            format!(
                "must be lowercase letters and digits in segments joined by single hyphens, at most {MAX_ID_BYTES} bytes"
            ),
        );
    }
    if !text_within(&manifest.name, MAX_NAME_CHARS) {
        findings.error(
            Code::NameInvalid,
            "name",
            format!("must be 1–{MAX_NAME_CHARS} characters without control characters"),
        );
    }
    if semver::Version::parse(&manifest.version).is_err() {
        findings.error(
            Code::VersionInvalid,
            "version",
            "must be a semantic version such as 1.0.0",
        );
    }
    if let Some(description) = &manifest.description {
        if !text_within(description, MAX_DESCRIPTION_CHARS) {
            findings.error(
                Code::DescriptionInvalid,
                "description",
                format!(
                    "must be 1–{MAX_DESCRIPTION_CHARS} characters without control characters when set"
                ),
            );
        }
    }
}

fn text_within(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn validate_member(index: usize, member: &PluginMember, findings: &mut PluginFindings) {
    let field = format!("contributes[{index}]");
    let Some(kind) = member.member_kind() else {
        findings.error(
            Code::MemberKindInvalid,
            format!("{field}.kind"),
            format!(
                "must be provider, theme, tab or lsp (plugins cannot contribute `{}`)",
                member.kind
            ),
        );
        return;
    };
    if !is_member_path(&member.path) {
        findings.error(
            Code::MemberPathInvalid,
            format!("{field}.path"),
            "must be a normalized relative directory inside the plugin folder",
        );
    }
    match (kind, member.descriptor.as_deref()) {
        (PluginMemberKind::Provider, None) => findings.error(
            Code::MemberDescriptorRequired,
            format!("{field}.descriptor"),
            "provider members must name their host descriptor file",
        ),
        (PluginMemberKind::Provider, Some(descriptor)) if !is_member_path(descriptor) => findings
            .error(
                Code::MemberDescriptorInvalid,
                format!("{field}.descriptor"),
                "must be a normalized relative file path inside the plugin folder",
            ),
        (PluginMemberKind::Theme | PluginMemberKind::Tab | PluginMemberKind::Lsp, Some(_)) => {
            findings.error(
                Code::MemberDescriptorUnexpected,
                format!("{field}.descriptor"),
                format!("{kind} members declare no descriptor"),
            )
        }
        _ => {}
    }
}

/// [`crate::is_normalized_relative_path`] without `:`, so a path means the
/// same folder on every platform.
fn is_member_path(path: &str) -> bool {
    crate::tab::is_clean_relative_path(path)
}

/// Member folders are distinct and never inside one another, compared
/// case-insensitively (macOS volumes usually are).
fn validate_member_paths(members: &[PluginMember], findings: &mut PluginFindings) {
    let segments: Vec<Option<Vec<String>>> = members
        .iter()
        .map(|member| {
            is_member_path(&member.path).then(|| {
                member
                    .path
                    .split('/')
                    .map(str::to_ascii_lowercase)
                    .collect()
            })
        })
        .collect();
    for (index, path) in segments.iter().enumerate() {
        let Some(path) = path else { continue };
        for (earlier, other) in segments[..index].iter().enumerate() {
            let Some(other) = other else { continue };
            let field = format!("contributes[{index}].path");
            if path == other {
                findings.error(
                    Code::MemberPathDuplicate,
                    field,
                    format!("is also the path of contributes[{earlier}]"),
                );
            } else if path.starts_with(other) || other.starts_with(path) {
                findings.error(
                    Code::MemberPathNested,
                    field,
                    format!("must not contain or sit inside contributes[{earlier}].path"),
                );
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};

    pub(crate) fn manifest_json() -> Value {
        json!({"schema_version":1,"kind":"plugin","id":"aurora","name":"Aurora",
            "version":"1.0.0","description":"Agent, tab and theme",
            "contributes":[
                {"kind":"provider","path":"agent","descriptor":"agent/aurora-agent.json"},
                {"kind":"tab","path":"aurora-tab"},
                {"kind":"theme","path":"theme"}]})
    }

    fn codes(value: Value) -> Vec<&'static str> {
        let manifest: PluginManifest = serde_json::from_value(value).unwrap();
        validate_manifest(&manifest)
            .errors
            .iter()
            .map(|issue| issue.code.as_str())
            .collect()
    }

    fn with(pointer: &str, replacement: Value) -> Value {
        let mut value = manifest_json();
        *value.pointer_mut(pointer).unwrap() = replacement;
        value
    }

    #[test]
    fn accepts_the_documented_manifest() {
        assert!(codes(manifest_json()).is_empty());
        let mut minimal = manifest_json();
        minimal.as_object_mut().unwrap().remove("description");
        minimal["contributes"] = json!([{"kind":"theme","path":"themes/dark"}]);
        assert!(codes(minimal).is_empty());
    }

    #[test]
    fn manifests_are_closed() {
        let mut unknown = manifest_json();
        unknown["icon"] = json!("icon.svg");
        assert!(serde_json::from_value::<PluginManifest>(unknown).is_err());
        let mut member = manifest_json();
        member["contributes"][1]["entry"] = json!("index.html");
        assert!(serde_json::from_value::<PluginManifest>(member).is_err());
    }

    #[test]
    fn identity_rules_have_stable_codes() {
        let cases = [
            ("/schema_version", json!(2), "SCHEMA_VERSION_UNSUPPORTED"),
            ("/kind", json!("tab"), "KIND_INVALID"),
            ("/id", json!("Aurora"), "ID_INVALID"),
            ("/id", json!("a--b"), "ID_INVALID"),
            ("/id", json!("-a"), "ID_INVALID"),
            ("/id", json!("a".repeat(65)), "ID_INVALID"),
            ("/name", json!("  "), "NAME_INVALID"),
            ("/name", json!("a\nb"), "NAME_INVALID"),
            ("/version", json!("1.0"), "VERSION_INVALID"),
            ("/description", json!(""), "DESCRIPTION_INVALID"),
        ];
        for (pointer, replacement, code) in cases {
            assert_eq!(codes(with(pointer, replacement)), [code], "{pointer}");
        }
        assert!(is_valid_plugin_id(&"a".repeat(64)));
        assert!(is_valid_plugin_id("aurora-2"));
    }

    #[test]
    fn member_rules_have_stable_codes() {
        let cases = [
            ("/contributes", json!([]), "MEMBERS_COUNT_INVALID"),
            (
                "/contributes/1/kind",
                json!("plugin"),
                "MEMBER_KIND_INVALID",
            ),
            (
                "/contributes/1/path",
                json!("../tab"),
                "MEMBER_PATH_INVALID",
            ),
            ("/contributes/1/path", json!("/tab"), "MEMBER_PATH_INVALID"),
            ("/contributes/1/path", json!("c:tab"), "MEMBER_PATH_INVALID"),
            (
                "/contributes/1/path",
                json!("Agent"),
                "MEMBER_PATH_DUPLICATE",
            ),
            (
                "/contributes/1/path",
                json!("agent/tab"),
                "MEMBER_PATH_NESTED",
            ),
            (
                "/contributes/0/descriptor",
                json!("../a.json"),
                "MEMBER_DESCRIPTOR_INVALID",
            ),
        ];
        for (pointer, replacement, code) in cases {
            assert_eq!(codes(with(pointer, replacement)), [code], "{pointer}");
        }
        let mut missing = manifest_json();
        missing["contributes"][0]
            .as_object_mut()
            .unwrap()
            .remove("descriptor");
        assert_eq!(codes(missing), ["MEMBER_DESCRIPTOR_REQUIRED"]);
        let mut unexpected = manifest_json();
        unexpected["contributes"][2]["descriptor"] = json!("theme/x.json");
        assert_eq!(codes(unexpected), ["MEMBER_DESCRIPTOR_UNEXPECTED"]);
        let seven = json!((0..7)
            .map(|index| json!({"kind":"theme","path":format!("theme-{index}")}))
            .collect::<Vec<_>>());
        assert_eq!(
            codes(with("/contributes", seven)),
            ["MEMBERS_COUNT_INVALID"]
        );
    }

    #[test]
    fn every_problem_is_reported_at_once() {
        let mut value = with("/id", json!("BAD"));
        value["version"] = json!("x");
        value["contributes"][2]["path"] = json!("agent");
        assert_eq!(
            codes(value),
            ["ID_INVALID", "VERSION_INVALID", "MEMBER_PATH_DUPLICATE"]
        );
    }
}
