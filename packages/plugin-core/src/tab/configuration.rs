//! `configuration`: the settings form a tab declares.

use std::collections::BTreeSet;

use super::issues::{TabFindings, TabIssueCode as Code};
use super::manifest::{TabConfigField, TabConfigFieldType};
use super::validate::text_within;

pub(crate) const MAX_CONFIG_FIELDS: usize = 32;
pub const MAX_CONFIG_KEY_LEN: usize = 48;
pub const MAX_CONFIG_LABEL_CHARS: usize = 64;

pub(super) fn validate(fields: &[TabConfigField], findings: &mut TabFindings) {
    if fields.len() > MAX_CONFIG_FIELDS {
        findings.error(
            Code::ConfigTooMany,
            "configuration",
            format!("at most {MAX_CONFIG_FIELDS} fields"),
        );
    }
    let mut keys = BTreeSet::new();
    for (index, field) in fields.iter().enumerate() {
        let at = |name: &str| format!("configuration[{index}].{name}");
        if !is_valid_config_key(&field.key) {
            findings.error(
                Code::ConfigKeyInvalid,
                at("key"),
                "must match ^[a-z][a-z0-9_]{0,47}$",
            );
        } else if !keys.insert(field.key.as_str()) {
            findings.error(
                Code::ConfigKeyDuplicate,
                at("key"),
                format!("`{}` is declared twice", field.key),
            );
        }
        if !text_within(&field.label, MAX_CONFIG_LABEL_CHARS) {
            findings.error(
                Code::ConfigLabelInvalid,
                at("label"),
                format!("must be 1–{MAX_CONFIG_LABEL_CHARS} characters"),
            );
        }
        validate_shape(field, findings, &at);
    }
}

fn validate_shape(field: &TabConfigField, findings: &mut TabFindings, at: &dyn Fn(&str) -> String) {
    let select = field.field_type == TabConfigFieldType::Select;
    if select && field.options.iter().all(|option| option.trim().is_empty()) {
        findings.error(
            Code::ConfigOptionsRequired,
            at("options"),
            "a select needs at least one option",
        );
    } else if !select && !field.options.is_empty() {
        findings.error(
            Code::ConfigOptionsUnexpected,
            at("options"),
            "only select fields take options",
        );
    } else if select {
        validate_options(&field.options, findings, at);
    }
    let Some(default) = &field.default else {
        return;
    };
    if field.field_type == TabConfigFieldType::Secret {
        findings.error(
            Code::ConfigSecretDefault,
            at("default"),
            "a secret cannot have a default",
        );
    } else if !field.accepts(default) {
        findings.error(
            Code::ConfigDefaultInvalid,
            at("default"),
            "does not match the field's type or options",
        );
    }
}

/// Each option is a choice the settings form lists: a blank one (a select
/// item cannot take an empty value) or the same one twice cannot be told apart.
fn validate_options(options: &[String], findings: &mut TabFindings, at: &dyn Fn(&str) -> String) {
    let mut seen = BTreeSet::new();
    for (index, option) in options.iter().enumerate() {
        let problem = if option.trim().is_empty() {
            "cannot be blank"
        } else if !seen.insert(option.as_str()) {
            "is listed twice"
        } else {
            continue;
        };
        findings.error(
            Code::ConfigOptionInvalid,
            at(&format!("options[{index}]")),
            problem,
        );
    }
}

/// `^[a-z][a-z0-9_]{0,47}$`.
pub(crate) fn is_valid_config_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_CONFIG_KEY_LEN
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::test_support::codes;
    use serde_json::{json, Value};

    fn check(fields: Value) -> TabFindings {
        let fields: Vec<TabConfigField> = serde_json::from_value(fields).unwrap();
        let mut findings = TabFindings::default();
        validate(&fields, &mut findings);
        findings
    }

    #[test]
    fn the_contract_example_is_valid() {
        let findings = check(json!([
            { "key": "gitlab_url", "type": "string", "label": "GitLab URL", "scope": "global" },
            { "key": "gitlab_token", "type": "secret", "label": "Access token", "scope": "global" },
            { "key": "group", "type": "select", "label": "Grouping", "scope": "project",
              "options": ["directory", "extension"], "default": "directory" }
        ]));
        assert!(findings.is_valid(), "{findings:?}");
    }

    #[test]
    fn keys_are_well_formed_and_unique() {
        for key in ["a", "a_b", "a1", &format!("a{}", "b".repeat(47))] {
            assert!(is_valid_config_key(key), "{key}");
        }
        for key in ["", "1a", "_a", "A", "a-b", &format!("a{}", "b".repeat(48))] {
            assert!(!is_valid_config_key(key), "{key}");
        }
        let findings = check(json!([
            { "key": "Bad", "type": "string", "label": "L", "scope": "global" },
            { "key": "k", "type": "string", "label": "L", "scope": "global" },
            { "key": "k", "type": "number", "label": "", "scope": "project" }
        ]));
        assert_eq!(
            codes(&findings.errors),
            [
                "CONFIG_KEY_INVALID",
                "CONFIG_KEY_DUPLICATE",
                "CONFIG_LABEL_INVALID"
            ]
        );
    }

    #[test]
    fn select_options_and_defaults_are_checked() {
        let findings = check(json!([
            { "key": "a", "type": "select", "label": "A", "scope": "global" },
            { "key": "b", "type": "string", "label": "B", "scope": "global", "options": ["x"] },
            { "key": "c", "type": "secret", "label": "C", "scope": "global", "default": "t" },
            { "key": "d", "type": "select", "label": "D", "scope": "global",
              "options": ["x"], "default": "y" },
            { "key": "e", "type": "boolean", "label": "E", "scope": "global", "default": "yes" }
        ]));
        assert_eq!(
            codes(&findings.errors),
            [
                "CONFIG_OPTIONS_REQUIRED",
                "CONFIG_OPTIONS_UNEXPECTED",
                "CONFIG_SECRET_DEFAULT",
                "CONFIG_DEFAULT_INVALID",
                "CONFIG_DEFAULT_INVALID"
            ]
        );
    }

    #[test]
    fn select_options_are_neither_blank_nor_repeated() {
        let findings = check(json!([
            { "key": "a", "type": "select", "label": "A", "scope": "global",
              "options": ["", "auto"] },
            { "key": "b", "type": "select", "label": "B", "scope": "global",
              "options": ["x", " ", "x"] }
        ]));
        assert_eq!(
            codes(&findings.errors),
            [
                "CONFIG_OPTION_INVALID",
                "CONFIG_OPTION_INVALID",
                "CONFIG_OPTION_INVALID"
            ]
        );
        let fields: Vec<_> = findings
            .errors
            .iter()
            .map(|issue| issue.field.clone())
            .collect();
        assert_eq!(
            fields,
            [
                Some("configuration[0].options[0]".to_string()),
                Some("configuration[1].options[1]".to_string()),
                Some("configuration[1].options[2]".to_string())
            ]
        );
    }

    #[test]
    fn field_count_is_bounded() {
        let fields: Vec<Value> = (0..33)
            .map(|n| json!({"key": format!("k{n}"), "type": "string", "label": "L", "scope": "global"}))
            .collect();
        assert_eq!(
            codes(&check(Value::Array(fields)).errors),
            ["CONFIG_TOO_MANY"]
        );
    }
}
