//! The rules of `docs/CUSTOM_TABS.md` §3 for one parsed manifest.
//!
//! Pure: no filesystem access. Folder-level checks (id equals the folder name,
//! icon present and bounded) live in `folder.rs`.

use std::collections::BTreeSet;

use super::issues::{TabFindings, TabIssueCode as Code};
use super::manifest::TabManifest;
use super::{
    configuration, contributions, execution, network, shortcuts, REPLACEABLE_TABS, SCOPES,
    SUPPORTED_API_VERSION, SUPPORTED_SCHEMA_VERSIONS,
};

pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_DESCRIPTION_CHARS: usize = 280;
pub const MAX_LABEL_CHARS: usize = 24;
pub const MAX_ID_LEN: usize = 64;

/// Ids that would collide with the host's own `/api/plugin-tabs/<segment>` routes
/// (every static second segment the service registers there).
pub const RESERVED_IDS: [&str; 4] = ["authoring", "grants", "self", "ws"];

/// Validate every manifest rule that does not need the folder.
pub fn validate_manifest(manifest: &TabManifest) -> TabFindings {
    let mut findings = TabFindings::default();
    validate_identity(manifest, &mut findings);
    validate_text(manifest, &mut findings);
    validate_paths(manifest, &mut findings);
    validate_permissions(&manifest.permissions, &mut findings);
    validate_replaces(manifest.replaces(), &mut findings);
    if let Some(network) = &manifest.network {
        network::validate(network, &mut findings);
    }
    configuration::validate(&manifest.configuration, &mut findings);
    execution::validate_commands(&manifest.commands, &mut findings);
    if let Some(backend) = &manifest.backend {
        execution::validate_backend(backend, &mut findings);
    }
    shortcuts::validate(&manifest.shortcuts, &mut findings);
    contributions::validate(manifest, &mut findings);
    findings
}

/// `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` — a URL host label.
pub fn is_valid_tab_id(id: &str) -> bool {
    is_label(id, MAX_ID_LEN)
}

/// 1–`max_len` lowercase letters, digits or inner hyphens.
pub(super) fn is_label(id: &str, max_len: usize) -> bool {
    let bytes = id.as_bytes();
    let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= max_len
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|byte| edge(byte) || *byte == b'-')
}

fn validate_identity(manifest: &TabManifest, findings: &mut TabFindings) {
    if !SUPPORTED_SCHEMA_VERSIONS.contains(&manifest.schema_version) {
        findings.error(
            Code::SchemaVersionUnsupported,
            "schema_version",
            "this Cadencr supports schema_version 1 or 2",
        );
    }
    if manifest.kind != "tab" {
        findings.error(Code::KindInvalid, "kind", "must be \"tab\"");
    }
    if !is_valid_tab_id(&manifest.id) {
        findings.error(
            Code::IdInvalid,
            "id",
            "must be 1–64 lowercase letters, digits or inner hyphens",
        );
    } else if RESERVED_IDS.contains(&manifest.id.as_str()) {
        findings.error(Code::IdReserved, "id", "is reserved by Cadencr");
    }
    if manifest.api_version != SUPPORTED_API_VERSION {
        findings.error(
            Code::ApiVersionUnsupported,
            "api_version",
            format!("this Cadencr supports api_version {SUPPORTED_API_VERSION}"),
        );
    }
    if semver::Version::parse(&manifest.version).is_err() {
        findings.error(
            Code::VersionInvalid,
            "version",
            "must be a semantic version such as 0.1.0",
        );
    }
}

fn validate_text(manifest: &TabManifest, findings: &mut TabFindings) {
    if !text_within(&manifest.name, MAX_NAME_CHARS) {
        findings.error(
            Code::NameInvalid,
            "name",
            format!("must be 1–{MAX_NAME_CHARS} characters"),
        );
    }
    if let Some(description) = &manifest.description {
        if description.chars().count() > MAX_DESCRIPTION_CHARS {
            findings.error(
                Code::DescriptionTooLong,
                "description",
                format!("must be at most {MAX_DESCRIPTION_CHARS} characters"),
            );
        }
    }
    let label = manifest.tab.as_ref().and_then(|tab| tab.label.as_deref());
    if let Some(label) = label {
        if !text_within(label, MAX_LABEL_CHARS) {
            findings.error(
                Code::LabelInvalid,
                "tab.label",
                format!("must be 1–{MAX_LABEL_CHARS} characters"),
            );
        }
    } else if manifest.name.trim().chars().count() > MAX_LABEL_CHARS {
        findings.error(
            Code::LabelInvalid,
            "tab.label",
            format!("the name is used as the label and exceeds {MAX_LABEL_CHARS} characters; set tab.label"),
        );
    }
}

/// Non-blank after trimming, and at most `max` characters.
pub(crate) fn text_within(text: &str, max: usize) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= max
}

fn validate_paths(manifest: &TabManifest, findings: &mut TabFindings) {
    if !is_clean_relative_path(&manifest.entry) {
        findings.error(
            Code::PathInvalid,
            "entry",
            "must be a normalized relative path without `..`, `.`, backslashes or a leading `/`",
        );
    }
    if let Some(icon) = &manifest.icon {
        if !is_clean_relative_path(icon) {
            findings.error(
                Code::PathInvalid,
                "icon",
                "must be a normalized relative path without `..`, `.`, backslashes or a leading `/`",
            );
        } else if !icon.to_ascii_lowercase().ends_with(".svg") {
            findings.error(Code::IconInvalid, "icon", "must be an .svg file");
        }
    }
}

/// A [`crate::is_normalized_relative_path`] that also refuses `:`, so no
/// Windows drive prefix or alternate data stream can reach the host.
pub fn is_clean_relative_path(path: &str) -> bool {
    crate::is_normalized_relative_path(path) && !path.contains(':')
}

fn validate_permissions(permissions: &[String], findings: &mut TabFindings) {
    let mut seen = BTreeSet::new();
    for (index, permission) in permissions.iter().enumerate() {
        let field = format!("permissions[{index}]");
        if !SCOPES.contains(&permission.as_str()) {
            findings.error(
                Code::PermissionUnknown,
                field,
                format!("unknown scope `{permission}`; known: {}", SCOPES.join(", ")),
            );
        } else if !seen.insert(permission.as_str()) {
            findings.error(
                Code::PermissionDuplicate,
                field,
                format!("`{permission}` is listed twice"),
            );
        }
    }
}

fn validate_replaces(replaces: &[String], findings: &mut TabFindings) {
    let mut seen = BTreeSet::new();
    for (index, tab) in replaces.iter().enumerate() {
        let field = format!("tab.replaces[{index}]");
        if !REPLACEABLE_TABS.contains(&tab.as_str()) {
            findings.error(
                Code::ReplacesInvalid,
                field,
                format!(
                    "`{tab}` cannot be replaced; replaceable tabs: {}",
                    REPLACEABLE_TABS.join(", ")
                ),
            );
        } else if !seen.insert(tab.as_str()) {
            findings.error(
                Code::ReplacesDuplicate,
                field,
                format!("`{tab}` is listed twice"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::test_support::{codes, manifest};
    use serde_json::json;

    #[test]
    fn editor_contributions_require_v2_and_a_backend() {
        let editor = json!({"editor": {"label": "Demo editor", "open_method": "editor.open"}});
        let base = json!({"schema_version": 2, "contributes": editor, "backend": {
            "protocol": 2, "binary": {"linux-x86_64": "bin/editor"}, "reasoning": "Edit files"
        }});
        let findings = validate_manifest(&manifest(base.clone()));
        assert!(findings.is_valid(), "{findings:?}");
        for overrides in [
            json!({"schema_version": 1}),
            json!({"backend": null}),
            json!({"contributes": {"editor": {"label": "", "open_method": "editor.open"}}}),
            json!({"contributes": {"editor": {"label": "Editor", "open_method": ""}}}),
        ] {
            let mut invalid = base.clone();
            for (key, value) in overrides.as_object().unwrap() {
                invalid[key] = value.clone();
            }
            assert!(!validate_manifest(&manifest(invalid)).is_valid());
        }
    }

    #[test]
    fn the_contract_example_is_valid() {
        let findings = validate_manifest(&manifest(json!({})));
        assert!(findings.is_valid(), "{findings:?}");
        assert!(findings.warnings.is_empty());
    }

    #[test]
    fn ids_follow_the_host_label_grammar() {
        for valid in ["a", "a1", "changed-files-graph", "a--b", &"a".repeat(64)] {
            assert!(is_valid_tab_id(valid), "{valid}");
        }
        for invalid in [
            "",
            "-a",
            "a-",
            "A",
            "a_b",
            "a.b",
            "a/b",
            "..",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_tab_id(invalid), "{invalid}");
        }
        assert_eq!(
            codes(&validate_manifest(&manifest(json!({"id": "Bad"}))).errors),
            ["ID_INVALID"]
        );
        for reserved in RESERVED_IDS {
            assert_eq!(
                codes(&validate_manifest(&manifest(json!({"id": reserved}))).errors),
                ["ID_RESERVED"],
                "{reserved}"
            );
        }
    }

    #[test]
    fn identity_fields_are_checked() {
        let findings = validate_manifest(&manifest(json!({
            "schema_version": 3, "kind": "theme", "api_version": 2, "version": "1.0"
        })));
        assert_eq!(
            codes(&findings.errors),
            [
                "SCHEMA_VERSION_UNSUPPORTED",
                "KIND_INVALID",
                "API_VERSION_UNSUPPORTED",
                "VERSION_INVALID"
            ]
        );
    }

    #[test]
    fn text_lengths_are_bounded() {
        let findings = validate_manifest(&manifest(json!({
            "name": " ",
            "description": "x".repeat(281),
            "tab": {"label": "x".repeat(25)}
        })));
        assert_eq!(
            codes(&findings.errors),
            ["NAME_INVALID", "DESCRIPTION_TOO_LONG", "LABEL_INVALID"]
        );
        let long_name = validate_manifest(&manifest(json!({
            "name": "A name that is longer than the tab", "tab": null
        })));
        assert_eq!(codes(&long_name.errors), ["LABEL_INVALID"]);
        let ok = validate_manifest(&manifest(json!({
            "name": "x".repeat(64), "description": "é".repeat(280)
        })));
        assert!(ok.is_valid(), "{ok:?}");
    }

    #[test]
    fn paths_must_be_clean_and_relative() {
        for path in ["dist/index.html", "index.html", "a/b/c.html"] {
            assert!(is_clean_relative_path(path), "{path}");
        }
        for path in [
            "", "/abs", "../x", "a/../b", "./a", "a//b", "a\\b", "C:/x", "a/", "a/./b",
        ] {
            assert!(!is_clean_relative_path(path), "{path}");
        }
        let findings = validate_manifest(&manifest(json!({
            "entry": "../outside.html", "icon": "icon.png"
        })));
        assert_eq!(codes(&findings.errors), ["PATH_INVALID", "ICON_INVALID"]);
        let traversal = validate_manifest(&manifest(json!({"icon": "../icon.svg"})));
        assert_eq!(codes(&traversal.errors), ["PATH_INVALID"]);
    }

    #[test]
    fn permissions_are_known_and_unique() {
        let findings = validate_manifest(&manifest(json!({
            "permissions": ["git:read", "git:write", "git:read"]
        })));
        assert_eq!(
            codes(&findings.errors),
            ["PERMISSION_UNKNOWN", "PERMISSION_DUPLICATE"]
        );
        assert_eq!(findings.errors[1].field.as_deref(), Some("permissions[2]"));
        let all = validate_manifest(&manifest(json!({ "permissions": SCOPES })));
        assert!(all.is_valid(), "{all:?}");
    }

    #[test]
    fn replaced_tabs_are_replaceable_built_ins_listed_once() {
        let findings = validate_manifest(&manifest(json!({
            "tab": {"label": "VCS", "replaces": ["git", "agent", "browser", "git"]}
        })));
        assert_eq!(
            codes(&findings.errors),
            ["REPLACES_INVALID", "REPLACES_INVALID", "REPLACES_DUPLICATE"]
        );
        assert_eq!(findings.errors[2].field.as_deref(), Some("tab.replaces[3]"));
        let all = validate_manifest(&manifest(json!({
            "tab": {"label": "VCS", "replaces": REPLACEABLE_TABS}
        })));
        assert!(all.is_valid(), "{all:?}");
    }
}
