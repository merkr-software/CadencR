//! Reads the user's `~/.config/alacritty/alacritty.toml` for the terminal
//! panel's font, colors, cursor style, and scrollback depth. Read-only —
//! this module never writes to the file. A missing file is normal (most
//! users don't have one) and produces Alacritty's own documented defaults,
//! field by field; a *malformed* file is a real condition the caller should
//! be able to surface, since it means the user's real settings are silently
//! not being honored.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, Debouncer};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{debug, warn};
use utoipa::ToSchema;

mod resolve;

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
/// The fallback palette is included only when no usable config was loaded.
/// Parsed configs preserve omitted colors so the renderer can inherit the
/// currently selected Cadencr theme.
pub fn read_alacritty_config_response(fallback_palette: AnsiPalette) -> AlacrittyConfigResponse {
    let Some(path) = default_config_path() else {
        return AlacrittyConfigResponse {
            config: merge_with_fallback(AlacrittyConfig::default(), &fallback_palette),
            found: false,
            parse_error: None,
        };
    };
    match resolve::resolve_alacritty_config(&path) {
        Ok(Some((config, _touched))) => AlacrittyConfigResponse {
            // Preserve omitted colors so the renderer can inherit its current
            // Cadencr theme rather than treating our dark fallback as explicit.
            config,
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

    // Resolve once at startup to learn every file this config chain actually
    // touches (the root plus every `general.import`, transitively) — an
    // import living in a different directory (e.g. `themes/font.toml`) needs
    // its own directory watched, or edits to it would never trigger a
    // refetch. Best-effort: a resolution failure here still starts a watcher
    // on the root's own directory, so an existing valid config keeps live
    // reload even if a newly-broken import can't be resolved yet. Fixed for
    // the process lifetime: a brand-new import path added later needs a
    // service restart to be picked up.
    let touched = match resolve::resolve_alacritty_config(&config_path) {
        Ok(Some((_, touched))) => touched,
        _ => vec![config_path.clone()],
    };

    let watched_names: HashSet<std::ffi::OsString> = touched
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_owned()))
        .collect();
    let watch_dirs: HashSet<PathBuf> = touched
        .iter()
        .filter_map(|p| p.parent().map(std::path::Path::to_path_buf))
        .collect();

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
                .any(|e| is_watched_config_file(&e.path, &watched_names));
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

    // Watching each directory (not the files themselves) survives editors
    // that save by replacing the file (write-to-temp-then-rename) rather
    // than writing in place — a watch on a file's own inode would go stale
    // the moment such an editor "saves."
    for dir in &watch_dirs {
        if let Err(e) = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
            warn!(dir = %dir.display(), "failed to watch alacritty config dir: {e}");
        }
    }
    let _ = WATCHER.set(debouncer);
    debug!(dirs = ?watch_dirs, "alacritty config watcher started");
}

/// Whether `path`'s file name matches one of the config chain's own files —
/// the root or one of its imports, not some unrelated file dropped in the
/// same directory (e.g. a `.alacritty.toml.swp` an editor leaves behind).
fn is_watched_config_file(
    path: &std::path::Path,
    watched_names: &HashSet<std::ffi::OsString>,
) -> bool {
    path.file_name()
        .is_some_and(|name| watched_names.contains(name))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn matches_only_files_in_the_watched_set() {
        let watched: HashSet<std::ffi::OsString> = [
            std::ffi::OsString::from("alacritty.toml"),
            std::ffi::OsString::from("font.toml"),
        ]
        .into_iter()
        .collect();
        assert!(is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/alacritty.toml"),
            &watched
        ));
        assert!(is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/themes/font.toml"),
            &watched
        ));
        assert!(!is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/alacritty.toml.swp"),
            &watched
        ));
        assert!(!is_watched_config_file(
            std::path::Path::new("/home/user/.config/alacritty/themes/other.toml"),
            &watched
        ));
    }
}
