//! Reads the user's `~/.config/alacritty/alacritty.toml` for the terminal
//! panel's font, colors, cursor style, and scrollback depth. Read-only —
//! this module never writes to the file. A missing file is normal (most
//! users don't have one) and produces Alacritty's own documented defaults,
//! field by field; a *malformed* file is a real condition the caller should
//! be able to surface, since it means the user's real settings are silently
//! not being honored.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

mod resolve;
mod watcher;

pub use watcher::{start_watcher, AlacrittyConfigChangedEvent};

/// Alacritty's own documented default: `font.size`.
const DEFAULT_FONT_SIZE: f64 = 11.25;
/// Alacritty's own documented default: `scrolling.history`.
const DEFAULT_SCROLLBACK_HISTORY: u32 = 10_000;
/// Alacritty's own documented default: `cursor.style.shape`.
const DEFAULT_CURSOR_SHAPE: &str = "Block";
/// Alacritty's own documented default: `cursor.style.blinking`.
const DEFAULT_CURSOR_BLINKING: &str = "Off";

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(default)]
pub struct AlacrittyConfig {
    pub font: FontConfig,
    pub colors: ColorsConfig,
    pub cursor: CursorConfig,
    pub scrolling: ScrollingConfig,
}

impl Default for AlacrittyConfig {
    fn default() -> Self {
        Self {
            font: FontConfig::default(),
            colors: ColorsConfig::default(),
            cursor: CursorConfig::default(),
            scrolling: ScrollingConfig::default(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Default)]
#[serde(default)]
pub struct FontFace {
    pub family: Option<String>,
    pub style: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(default)]
pub struct FontConfig {
    /// Only `[font.normal]` is parsed — see this task's "Technical
    /// constraint" for why bold/italic/bold_italic are out of scope.
    pub normal: FontFace,
    pub size: f64,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            normal: FontFace::default(),
            size: DEFAULT_FONT_SIZE,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Default)]
#[serde(default)]
pub struct PrimaryColors {
    pub foreground: Option<String>,
    pub background: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Default)]
#[serde(default)]
pub struct CursorColors {
    /// Verbatim from the file: either a hex color or the sentinel strings
    /// `"CellBackground"`/`"CellForeground"`. Not validated or resolved
    /// here — that's the consumer's job (Plan 3).
    pub text: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Clone, Default)]
#[serde(default)]
pub struct AnsiPalette {
    /// Per-color: Alacritty lets a file override a single ANSI color
    /// (e.g. only `[colors.normal] red`), so `None` means "not overridden
    /// anywhere in the chain" and the consumer fills it from its own theme.
    pub black: Option<String>,
    pub red: Option<String>,
    pub green: Option<String>,
    pub yellow: Option<String>,
    pub blue: Option<String>,
    pub magenta: Option<String>,
    pub cyan: Option<String>,
    pub white: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Default)]
#[serde(default)]
pub struct ColorsConfig {
    pub primary: PrimaryColors,
    pub cursor: CursorColors,
    pub normal: AnsiPalette,
    pub bright: AnsiPalette,
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Clone)]
#[serde(default)]
pub struct CursorStyle {
    pub shape: String,
    pub blinking: String,
}

impl Default for CursorStyle {
    fn default() -> Self {
        Self {
            shape: DEFAULT_CURSOR_SHAPE.to_string(),
            blinking: DEFAULT_CURSOR_BLINKING.to_string(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(default)]
pub struct CursorConfig {
    pub style: CursorStyle,
}

impl Default for CursorConfig {
    fn default() -> Self {
        Self {
            style: CursorStyle::default(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq)]
#[serde(default)]
pub struct ScrollingConfig {
    pub history: u32,
}

impl Default for ScrollingConfig {
    fn default() -> Self {
        Self {
            history: DEFAULT_SCROLLBACK_HISTORY,
        }
    }
}

/// Default path: `~/.config/alacritty/alacritty.toml`. `None` only when the
/// home directory itself can't be resolved (no `$HOME`, no passwd entry —
/// see `dirs::home_dir()`'s own doc comment for when that happens).
///
pub fn default_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join(".config")
            .join("alacritty")
            .join("alacritty.toml")
    })
}

/// `GET /api/terminal/alacritty-config` response.
#[derive(Debug, Serialize, ToSchema)]
pub struct AlacrittyConfigResponse {
    /// Always populated: either the user's real config, or Alacritty's own
    /// documented defaults (see `AlacrittyConfig`'s `Default` impls) when
    /// there's nothing to read or it failed to parse.
    pub config: AlacrittyConfig,
    /// `true` when `~/.config/alacritty/alacritty.toml` exists and parsed
    /// successfully.
    pub found: bool,
    /// Set only when the file exists but failed to parse — `config` is then
    /// defaults, not the user's real settings, and the frontend should
    /// surface this (Plan 3), not silently show defaults as if they were
    /// chosen.
    pub parse_error: Option<String>,
    /// Set while live reload is unavailable (the file watcher failed to
    /// start or to watch part of the import chain): `config` is still
    /// accurate, but external edits won't show up until a restart. Unlike
    /// `parse_error` this is not fatal — the frontend warns and keeps
    /// rendering.
    pub watch_error: Option<String>,
}

/// Read and parse the config at its default path, collapsing every outcome
/// (missing file, unresolvable `$HOME`, malformed file) into a response the
/// caller can always render — see this task's "Technical constraint" for
/// why none of these are modeled as an HTTP error.
///
/// The fallback palette is included only when no usable config was loaded.
/// Parsed configs preserve omitted colors so the renderer can inherit the
/// currently selected Cadencr theme.
pub fn read_alacritty_config_response(fallback_palette: AnsiPalette) -> AlacrittyConfigResponse {
    let fallback = || merge_with_fallback(AlacrittyConfig::default(), &fallback_palette);
    let resolved = default_config_path().map(|path| resolve::resolve_alacritty_config(&path));
    let (config, found, parse_error) = match resolved {
        // Preserve omitted colors so the renderer can inherit its current
        // Cadencr theme rather than treating our dark fallback as explicit.
        Some(Ok(Some((config, _touched)))) => (config, true, None),
        None | Some(Ok(None)) => (fallback(), false, None),
        Some(Err(e)) => (fallback(), false, Some(e)),
    };
    AlacrittyConfigResponse {
        config,
        found,
        parse_error,
        watch_error: watcher::watch_error(),
    }
}

/// Fill each color `config` leaves unset with the bundled fallback. This is
/// how the terminal panel gets a consistent color palette when there's no
/// usable config at all — with a usable config, `normal` preserves the
/// user's per-color overrides untouched and the renderer inherits its
/// currently selected Cadencr theme for the rest.
fn merge_with_fallback(config: AlacrittyConfig, fallback: &AnsiPalette) -> AlacrittyConfig {
    AlacrittyConfig {
        font: config.font,
        colors: ColorsConfig {
            primary: config.colors.primary,
            cursor: config.colors.cursor,
            normal: fill_palette_missing(config.colors.normal, fallback),
            bright: config.colors.bright,
        },
        cursor: config.cursor,
        scrolling: config.scrolling,
    }
}

/// Per-color fill from `fallback`, keeping every color the palette sets.
fn fill_palette_missing(palette: AnsiPalette, fallback: &AnsiPalette) -> AnsiPalette {
    AnsiPalette {
        black: palette.black.or_else(|| fallback.black.clone()),
        red: palette.red.or_else(|| fallback.red.clone()),
        green: palette.green.or_else(|| fallback.green.clone()),
        yellow: palette.yellow.or_else(|| fallback.yellow.clone()),
        blue: palette.blue.or_else(|| fallback.blue.clone()),
        magenta: palette.magenta.or_else(|| fallback.magenta.clone()),
        cyan: palette.cyan.or_else(|| fallback.cyan.clone()),
        white: palette.white.or_else(|| fallback.white.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_reports_found_true_only_on_successful_parse() {
        let fallback = AnsiPalette {
            black: Some("#1a1b1d".to_string()),
            red: Some("#ec707b".to_string()),
            green: Some("#8bcf67".to_string()),
            yellow: Some("#e2b64d".to_string()),
            blue: Some("#6d9bec".to_string()),
            magenta: Some("#de7ca7".to_string()),
            cyan: Some("#52bfd0".to_string()),
            white: Some("#c6c8cc".to_string()),
        };
        let response = read_alacritty_config_response(fallback);
        assert!(
            !(response.found && response.parse_error.is_some()),
            "a successfully parsed file must not also report a parse error"
        );
    }

    #[test]
    fn fallback_fills_only_the_colors_the_user_left_unset() {
        let fallback = AnsiPalette {
            black: Some("#1a1b1d".to_string()),
            red: Some("#ec707b".to_string()),
            green: Some("#8bcf67".to_string()),
            yellow: Some("#e2b64d".to_string()),
            blue: Some("#6d9bec".to_string()),
            magenta: Some("#de7ca7".to_string()),
            cyan: Some("#52bfd0".to_string()),
            white: Some("#c6c8cc".to_string()),
        };
        let config = fill_palette_missing(
            AnsiPalette {
                red: Some("#ff0000".to_string()),
                ..AnsiPalette::default()
            },
            &fallback,
        );
        assert_eq!(config.red.as_deref(), Some("#ff0000"), "user override wins");
        assert_eq!(
            config.green.as_deref(),
            Some("#8bcf67"),
            "unset colors take the bundled fallback"
        );
    }
}
