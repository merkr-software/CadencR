//! Optional host surfaces contributed by a tab plugin (manifest v2).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{issues::TabIssueCode as Code, TabFindings, TabManifest};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TabContributions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<TabEditorContribution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TabEditorContribution {
    pub label: String,
    /// Plugin-defined method receiving `{path, line?, column?}` (1-based positions).
    pub open_method: String,
}

pub(super) fn validate(manifest: &TabManifest, findings: &mut TabFindings) {
    let Some(editor) = manifest
        .contributes
        .as_ref()
        .and_then(|contributes| contributes.editor.as_ref())
    else {
        return;
    };
    let mut error =
        |field, message| findings.error(Code::EditorContributionInvalid, field, message);
    if manifest.schema_version < 2 {
        error("contributes.editor", "requires schema_version 2");
    }
    if manifest.backend.is_none() {
        error("contributes.editor", "requires a native backend");
    }
    if !super::validate::text_within(&editor.label, super::MAX_LABEL_CHARS) {
        error("contributes.editor.label", "must be 1–24 characters");
    }
    if editor.open_method.is_empty()
        || editor.open_method.len() > 128
        || !editor
            .open_method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        error(
            "contributes.editor.open_method",
            "must be 1–128 ASCII letters, digits or . _ : -",
        );
    }
}
