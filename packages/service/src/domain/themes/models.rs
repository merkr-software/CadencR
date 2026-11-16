use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::chrome::ThemeChrome;

pub use cadencr_plugin_core::theme::{ThemeAppearance, ThemeDocument, ThemeIssue, XtermPalette};

/// One entry in the theme gallery.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserTheme {
    /// Directory slug under `~/.cadencr/plugins/themes/`. The renderer applies it as
    /// `user:<id>`.
    pub id: String,
    /// Absolute path to `theme.json`, so the gallery can show and copy it.
    pub path: String,
    /// Raw file text, for the JSON editor and for export-to-file.
    pub content: String,
    /// The document's declared name, kept even when validation failed so the
    /// gallery can say *which* theme broke. `None` only when the file isn't
    /// parseable JSON at all.
    pub label: Option<String>,
    /// `None` when the document failed validation — the theme is listed and its
    /// issues shown, but it is never applied.
    pub theme: Option<ThemeDocument>,
    pub issues: Vec<ThemeIssue>,
    /// Asset file name → `data:` URL, for the files the theme's chrome
    /// references. Inlined rather than served from a URL: the renderer may be
    /// talking to a remote backend, its CSP allows `data:` images, and a
    /// stylesheet `url()` can't carry the API token anyway. Empty for the
    /// themes — nearly all of them — that reference no asset.
    pub assets: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThemeRequest {
    /// Human-readable name; the on-disk id is slugified from it.
    pub label: String,
    pub appearance: ThemeAppearance,
    pub css_vars: BTreeMap<String, String>,
    pub xterm: XtermPalette,
    #[serde(default)]
    pub chrome: ThemeChrome,
    /// Id of the user theme being duplicated, when there is one. Its asset
    /// files are copied into the new theme's folder — a texture the user can
    /// see is part of what they picked, so it has to come along.
    #[serde(default)]
    pub copy_assets_from: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CreateThemeResponse {
    pub theme: UserTheme,
    pub workspace: super::workspace::ThemeWorkspace,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct WriteThemeRequest {
    pub content: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WriteThemeResponse {
    pub theme: UserTheme,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DeleteThemeResponse {
    pub success: bool,
}
