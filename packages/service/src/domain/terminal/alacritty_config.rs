//! Reads the user's `~/.config/alacritty/alacritty.toml` for the terminal
//! panel's font, colors, cursor style, and scrollback depth. Read-only —
//! this module never writes to the file. A missing file is normal (most
//! users don't have one) and produces Alacritty's own documented defaults,
//! field by field; a *malformed* file is a real condition the caller should
//! be able to surface, since it means the user's real settings are silently
//! not being honored.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, Debouncer};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{debug, warn};
use utoipa::ToSchema;

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

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Clone)]
pub struct AnsiPalette {
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema, PartialEq, Default)]
#[serde(default)]
pub struct ColorsConfig {
    pub primary: PrimaryColors,
    pub cursor: CursorColors,
    /// `None` when the user's file doesn't override the 8 ANSI colors at
    /// all — unlike the other fields here, there's no single sensible
    /// "default 8-color palette" to fill in at this layer; the consumer
    /// (Plan 3) falls back to Cadencr's own bundled theme for this field.
    pub normal: Option<AnsiPalette>,
    pub bright: Option<AnsiPalette>,
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

/// Parse `path`. Returns `Ok(None)` when the file does not exist — that's
/// the common case (most users don't have this file) and is not an error.
/// Returns `Err` only when the file exists but fails to parse, since that
/// means the user's real settings are silently not being honored.
///
pub fn parse_alacritty_config(path: &std::path::Path) -> Result<Option<AlacrittyConfig>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };
    toml::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("failed to parse {}: {e}", path.display()))
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
}

/// Read and parse the config at its default path, collapsing every outcome
/// (missing file, unresolvable `$HOME`, malformed file) into a response the
/// caller can always render — see this task's "Technical constraint" for
/// why none of these are modeled as an HTTP error.
///
/// The `fallback_palette` is used to fill `colors.normal` when the user's
/// config doesn't override it — unlike Alacritty's own defaults, this is
/// the same palette the terminal panel already uses, so there's no visual
/// discontinuity when switching between "no config" and "config exists" states.
pub fn read_alacritty_config_response(fallback_palette: AnsiPalette) -> AlacrittyConfigResponse {
    let Some(path) = default_config_path() else {
        return AlacrittyConfigResponse {
            config: merge_with_fallback(AlacrittyConfig::default(), &fallback_palette),
            found: false,
            parse_error: None,
        };
    };
    match parse_alacritty_config(&path) {
        Ok(Some(config)) => AlacrittyConfigResponse {
            config: merge_with_fallback(config, &fallback_palette),
            found: true,
            parse_error: None,
        },
        Ok(None) => AlacrittyConfigResponse {
            config: merge_with_fallback(AlacrittyConfig::default(), &fallback_palette),
            found: false,
            parse_error: None,
        },
        Err(e) => AlacrittyConfigResponse {
            config: merge_with_fallback(AlacrittyConfig::default(), &fallback_palette),
            found: false,
            parse_error: Some(e),
        },
    }
}

/// Fill `colors.normal` with `fallback_palette` when the user's config
/// doesn't override it. This is how the terminal panel gets a consistent
/// color palette whether or not the user has an `alacritty.toml`.
fn merge_with_fallback(config: AlacrittyConfig, fallback: &AnsiPalette) -> AlacrittyConfig {
    let resolved = match config.colors.normal {
        Some(existing) => existing,
        None => AnsiPalette {
            black: fallback.black.clone(),
            red: fallback.red.clone(),
            green: fallback.green.clone(),
            yellow: fallback.yellow.clone(),
            blue: fallback.blue.clone(),
            magenta: fallback.magenta.clone(),
            cyan: fallback.cyan.clone(),
            white: fallback.white.clone(),
        },
    };
    AlacrittyConfig {
        font: config.font,
        colors: ColorsConfig {
            primary: config.colors.primary,
            cursor: config.colors.cursor,
            normal: Some(resolved),
            bright: config.colors.bright,
        },
        cursor: config.cursor,
        scrolling: config.scrolling,
    }
}

/// Emitted when `alacritty.toml` changes on disk. Carries no data — the
/// client re-fetches `GET /api/terminal/alacritty-config` on receiving one,
/// the same "ping, then re-fetch" convention `SettingsChangeEvent` already
/// uses for the settings directory.
#[derive(Clone, Debug, Serialize)]
pub struct AlacrittyConfigChangedEvent {}

/// Keeps the debouncer (and its underlying OS watcher) alive for the
/// process lifetime. Dropping it would silently stop notifications — same
/// reasoning as `settings_store::watcher`'s own `WATCHER` static.
static WATCHER: OnceLock<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>> =
    OnceLock::new();

/// Watch `~/.config/alacritty/alacritty.toml`'s parent directory
/// (non-recursive) and broadcast a ping on `tx` whenever the file itself
/// changes. Best-effort: a failure is logged, never fatal — the config
/// still loads once at startup via the HTTP route, just without live
/// external-edit refresh. No-ops (does not start a watcher, does not warn)
/// when the home directory can't be resolved at all.
pub fn start_watcher(tx: broadcast::Sender<AlacrittyConfigChangedEvent>) {
    let Some(config_path) = default_config_path() else {
        return;
    };
    let Some(watch_dir) = config_path.parent().map(std::path::Path::to_path_buf) else {
        return;
    };
    let target_file_name = config_path
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_default();

    let mut debouncer = match new_debouncer(
        Duration::from_millis(500),
        move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, _>| {
            let events = match result {
                Ok(events) => events,
                Err(e) => {
                    warn!("alacritty config watcher error: {e:?}");
                    return;
                }
            };
            let changed = events
                .iter()
                .any(|e| is_watched_config_file(&e.path, &target_file_name));
            if changed {
                debug!("alacritty.toml change detected");
                let _ = tx.send(AlacrittyConfigChangedEvent {});
            }
        },
    ) {
        Ok(debouncer) => debouncer,
        Err(e) => {
            warn!("failed to create alacritty config watcher: {e}");
            return;
        }
    };

    // Watching the parent directory (not the file itself) survives editors
    // that save by replacing the file (write-to-temp-then-rename) rather
    // than writing in place — a watch on the file's own inode would go
    // stale the moment such an editor "saves."
    if let Err(e) = debouncer
        .watcher()
        .watch(&watch_dir, RecursiveMode::NonRecursive)
    {
        warn!(dir = %watch_dir.display(), "failed to watch alacritty config dir: {e}");
        return;
    }
    let _ = WATCHER.set(debouncer);
    debug!(dir = %watch_dir.display(), "alacritty config watcher started");
}

/// Whether `path`'s file name matches `target_file_name` — the config file
/// itself, not some unrelated file in the same directory (e.g. a
/// `.alacritty.toml.swp` an editor drops next to it).
fn is_watched_config_file(path: &std::path::Path, target_file_name: &OsStr) -> bool {
    path.file_name() == Some(target_file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp_toml(contents: &str) -> tempfile::TempPath {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut file, contents.as_bytes()).unwrap();
        file.into_temp_path()
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let path = std::env::temp_dir().join("definitely-does-not-exist-alacritty.toml");
        assert_eq!(parse_alacritty_config(&path), Ok(None));
    }

    #[test]
    fn malformed_file_is_an_error_not_a_panic() {
        let path = write_temp_toml("this is not [ valid");
        let result = parse_alacritty_config(&path);
        assert!(result.is_err(), "expected an error, got {result:?}");
    }

    #[test]
    fn empty_file_gets_alacrittys_real_documented_defaults() {
        let path = write_temp_toml("");
        let config = parse_alacritty_config(&path).unwrap().unwrap();
        assert_eq!(config.scrolling.history, 10_000);
        assert_eq!(config.cursor.style.shape, "Block");
        assert_eq!(config.cursor.style.blinking, "Off");
        assert_eq!(config.font.size, 11.25);
        assert_eq!(config.font.normal.family, None);
        assert_eq!(config.colors.normal, None);
    }

    #[test]
    fn partial_file_only_overrides_what_it_sets() {
        let path = write_temp_toml("[cursor.style]\nshape = \"Beam\"\n");
        let config = parse_alacritty_config(&path).unwrap().unwrap();
        assert_eq!(config.cursor.style.shape, "Beam");
        // Untouched by the file — still Alacritty's documented default.
        assert_eq!(config.cursor.style.blinking, "Off");
        assert_eq!(config.scrolling.history, 10_000);
    }

    #[test]
    fn response_reports_found_true_only_on_successful_parse() {
        let fallback = AnsiPalette {
            black: "#1a1b1d".to_string(),
            red: "#ec707b".to_string(),
            green: "#8bcf67".to_string(),
            yellow: "#e2b64d".to_string(),
            blue: "#6d9bec".to_string(),
            magenta: "#de7ca7".to_string(),
            cyan: "#52bfd0".to_string(),
            white: "#c6c8cc".to_string(),
        };
        let response = read_alacritty_config_response(fallback);
        assert!(
            !(response.found && response.parse_error.is_some()),
            "a successfully parsed file must not also report a parse error"
        );
    }

    #[test]
    fn full_file_is_parsed_field_for_field() {
        // `r##"..."##`, not `r#"..."#`: the content contains `"#` sequences
        // (every `"#hexcolor"` value), which would otherwise close a
        // single-hash raw string early -- caught by actually compiling this
        // test while writing the plan, not by inspection.
        let path = write_temp_toml(
            r##"
[font]
size = 15

[font.normal]
family = "Iosevka Nerd Font Mono"
style = "Light"

[colors.primary]
foreground = "#cdd6f4"
background = "#1e1e2e"

[colors.cursor]
text = "#1e1e2e"
cursor = "#f5e0dc"

[colors.normal]
black = "#45475a"
red = "#f38ba8"
green = "#a6e3a1"
yellow = "#f9e2af"
blue = "#89b4fa"
magenta = "#f5c2e7"
cyan = "#94e2d5"
white = "#bac2de"

[colors.bright]
black = "#585b70"
red = "#f38ba8"
green = "#a6e3a1"
yellow = "#f9e2af"
blue = "#89b4fa"
magenta = "#f5c2e7"
cyan = "#94e2d5"
white = "#a6adc8"

[scrolling]
history = 5000
"##,
        );
        let config = parse_alacritty_config(&path).unwrap().unwrap();
        assert_eq!(config.font.size, 15.0);
        assert_eq!(
            config.font.normal.family.as_deref(),
            Some("Iosevka Nerd Font Mono")
        );
        assert_eq!(config.colors.primary.background.as_deref(), Some("#1e1e2e"));
        assert_eq!(config.colors.cursor.cursor.as_deref(), Some("#f5e0dc"));
        assert_eq!(config.colors.normal.unwrap().red, "#f38ba8");
        assert_eq!(config.scrolling.history, 5000);
        // Not set in the file -- still the real default, not zeroed.
        assert_eq!(config.cursor.style.shape, "Block");
    }

    #[test]
    fn matches_only_the_exact_config_file_name() {
        let target = OsStr::new("alacritty.toml");
        assert!(is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/alacritty.toml"),
            target
        ));
        assert!(!is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/alacritty.toml.swp"),
            target
        ));
        assert!(!is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/other.toml"),
            target
        ));
    }
}
