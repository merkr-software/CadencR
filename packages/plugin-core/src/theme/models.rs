use super::chrome::ThemeChrome;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

/// Light/dark classification. Drives `color-scheme`, the logo variant and the
/// editor's built-in fallback styling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ThemeAppearance {
    Light,
    Dark,
}

/// The xterm.js palette. Terminals are canvas-rendered and can't read CSS
/// variables, so every theme carries the palette explicitly.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct XtermPalette {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub selection_foreground: String,
    pub selection_inactive_background: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

/// A user theme exactly as stored in `~/.cadencr/plugins/themes/<id>/theme.json`.
///
/// This is the whole extensibility surface of step 1: pure data, no behavior.
/// `css_vars` is a closed set of known design tokens (see `tokens.rs`) whose
/// values must parse as CSS colors — a theme can never introduce arbitrary CSS.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDocument {
    /// Points at the JSON Schema Cadencr keeps beside this file, so an editor
    /// completes and checks the document as it is typed (see `schema.rs`).
    /// Optional and round-tripped rather than required: a theme written before
    /// this existed, or one whose author deleted the line, is still a theme.
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub label: String,
    pub appearance: ThemeAppearance,
    /// `--token` → CSS color value. Ordered so a round-trip through the editor
    /// doesn't reshuffle the file.
    pub css_vars: BTreeMap<String, String>,
    pub xterm: XtermPalette,
    /// Chassis, tabs and background texture (see `chrome.rs`). Defaulted, so a
    /// theme file written before chrome existed still parses — it simply gets
    /// the plain chrome every non-CadencR, non-Frost theme already had.
    #[serde(default)]
    pub chrome: ThemeChrome,
}

/// Why a theme can't be applied. Every issue is surfaced in the gallery; a
/// theme with any issue is never registered as applicable.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ThemeIssue {
    /// The offending token (`--background`), or `None` for document-level
    /// problems such as invalid JSON.
    pub token: Option<String>,
    pub message: String,
}

impl ThemeIssue {
    pub fn new(token: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            token: Some(token.into()),
            message: message.into(),
        }
    }

    /// A problem with the file as a whole rather than one token.
    pub fn document(message: impl Into<String>) -> Self {
        Self {
            token: None,
            message: message.into(),
        }
    }

    /// `--token: message`, or just the message for a document-level issue.
    pub fn describe(&self) -> String {
        match &self.token {
            Some(token) => format!("{token}: {}", self.message),
            None => self.message.clone(),
        }
    }
}
