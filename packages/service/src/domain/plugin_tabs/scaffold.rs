//! The starter app written into a new custom tab folder.
//!
//! A Vite + React 19 + Tailwind v4 + TypeScript app that already uses the SDK
//! and the kit, plus the three documents an author's agent reads first:
//! `INSTRUCTION.md` (the contract) and `AGENTS.md` / `CLAUDE.md` (the same short
//! boundary, under the two names coding agents load on their own).
//!
//! Templates are `.tmpl` files so no repository tooling (oxlint, tsc, pnpm)
//! mistakes them for code of this repository. The SDK and kit are vendored as
//! tarballs until they are published to npm.

use std::path::Path;

use cadencr_plugin_core::tab::{
    MANIFEST_FILE_NAME, MAX_LABEL_CHARS, SUPPORTED_API_VERSION, SUPPORTED_SCHEMA_VERSION,
};
use serde_json::json;

use crate::error::AppError;
use crate::shared::markup::escape_attribute;

/// Default scopes: enough for the demo (feature context and the `git.status` stream).
const DEFAULT_PERMISSIONS: [&str; 2] = ["features:read", "git:read"];
const ICON_FILE_NAME: &str = "icon.svg";
const ENTRY: &str = "dist/index.html";

const TEXT_FILES: [(&str, &str); 13] = [
    ("package.json", include_str!("scaffold/package.json.tmpl")),
    (
        "vite.config.ts",
        include_str!("scaffold/vite.config.ts.tmpl"),
    ),
    ("index.html", include_str!("scaffold/index.html.tmpl")),
    ("tsconfig.json", include_str!("scaffold/tsconfig.json.tmpl")),
    ("src/main.tsx", include_str!("scaffold/src/main.tsx.tmpl")),
    ("src/App.tsx", include_str!("scaffold/src/App.tsx.tmpl")),
    ("src/index.css", include_str!("scaffold/src/index.css.tmpl")),
    (ICON_FILE_NAME, include_str!("scaffold/icon.svg.tmpl")),
    (".gitignore", include_str!("scaffold/gitignore.tmpl")),
    ("README.md", include_str!("scaffold/README.md.tmpl")),
    (
        "INSTRUCTION.md",
        include_str!("scaffold/INSTRUCTION.md.tmpl"),
    ),
    ("AGENTS.md", include_str!("scaffold/AGENTS.md.tmpl")),
    ("CLAUDE.md", include_str!("scaffold/AGENTS.md.tmpl")),
];

const VENDOR_FILES: [(&str, &[u8]); 2] = [
    (
        "vendor/cadencr-tab-sdk.tgz",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/plugin-tabs/vendor/cadencr-tab-sdk.tgz"
        )),
    ),
    (
        "vendor/cadencr-tab-kit.tgz",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/plugin-tabs/vendor/cadencr-tab-kit.tgz"
        )),
    ),
];

/// What the scaffold is personalized with.
pub struct ScaffoldInput<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub description: Option<&'a str>,
}

/// Write the starter app into the (empty, existing) folder `dir`.
pub async fn write(dir: &Path, input: &ScaffoldInput<'_>) -> Result<(), AppError> {
    write_file(dir, MANIFEST_FILE_NAME, manifest(input).as_bytes()).await?;
    for (name, template) in TEXT_FILES {
        write_file(dir, name, personalize(template, input).as_bytes()).await?;
    }
    for (name, bytes) in VENDOR_FILES {
        write_file(dir, name, bytes).await?;
    }
    Ok(())
}

/// `tab.json` for a new tab. The label is the name cut to the label budget, so
/// a long name still yields a valid manifest.
pub fn manifest(input: &ScaffoldInput<'_>) -> String {
    let label: String = input.name.trim().chars().take(MAX_LABEL_CHARS).collect();
    let mut manifest = json!({
        "schema_version": SUPPORTED_SCHEMA_VERSION,
        "kind": "tab",
        "id": input.id,
        "name": input.name.trim(),
        "version": "0.1.0",
        "icon": ICON_FILE_NAME,
        "api_version": SUPPORTED_API_VERSION,
        "entry": ENTRY,
        "tab": { "label": label.trim_end() },
        "permissions": DEFAULT_PERMISSIONS,
    });
    if let Some(description) = input
        .description
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        manifest["description"] = json!(description);
    }
    let mut text = serde_json::to_string_pretty(&manifest).expect("a JSON value always serializes");
    text.push('\n');
    text
}

fn personalize(template: &str, input: &ScaffoldInput<'_>) -> String {
    template
        .replace("{{ID}}", input.id)
        .replace("{{NAME_HTML}}", &escape_attribute(input.name.trim()))
        .replace("{{NAME}}", input.name.trim())
}

async fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), AppError> {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::internal(format!("cannot create {}: {error}", parent.display()))
        })?;
    }
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| AppError::internal(format!("cannot write {}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cadencr_plugin_core::tab::inspect_tab_folder;

    #[tokio::test]
    async fn the_scaffold_is_a_valid_tab_with_every_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("my-tab");
        std::fs::create_dir(&dir).unwrap();
        let input = ScaffoldInput {
            id: "my-tab",
            name: "My <Tab> & a very long name indeed",
            description: Some("Shows things."),
        };
        write(&dir, &input).await.unwrap();
        let report = inspect_tab_folder(&dir);
        assert!(report.findings.is_valid(), "{:?}", report.findings);
        assert!(report.findings.warnings.is_empty(), "{:?}", report.findings);
        let manifest = report.manifest.unwrap();
        assert_eq!(manifest.permissions, DEFAULT_PERMISSIONS);
        assert_eq!(manifest.label(), "My <Tab> & a very long n");
        assert_eq!(manifest.description.as_deref(), Some("Shows things."));
        assert!(report.icon_svg.unwrap().contains("currentColor"));
        assert!(!report.entry_present, "nothing is built yet");
        let names = TEXT_FILES.iter().map(|(name, _)| *name);
        for name in names.chain(VENDOR_FILES.iter().map(|(name, _)| *name)) {
            assert!(dir.join(name).is_file(), "{name}");
        }
        let html = std::fs::read_to_string(dir.join("index.html")).unwrap();
        assert!(html.contains("<title>My &lt;Tab&gt; &amp; a very long name indeed</title>"));
        let package: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(package["name"], "my-tab");
        assert_eq!(package["scripts"]["dev"], "vite build --watch");
        assert_eq!(
            std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(),
            std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap()
        );
    }
}
