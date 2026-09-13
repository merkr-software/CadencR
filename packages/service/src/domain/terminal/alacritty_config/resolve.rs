//! Resolves `general.import` chains for `alacritty.toml`-family files: reads
//! the root file, recursively pulls in every imported file (Alacritty's own
//! layering behavior), and merges them with the precedence Alacritty itself
//! uses — later imports override earlier ones, and the importing file's own
//! fields override every import. Returns the final `AlacrittyConfig` plus
//! every file path touched, so the caller's file watcher can follow the whole
//! chain instead of only the root.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{
    AlacrittyConfig, ColorsConfig, CursorColors, CursorConfig, CursorStyle, FontConfig, FontFace,
    PrimaryColors, ScrollingConfig, DEFAULT_CURSOR_BLINKING, DEFAULT_CURSOR_SHAPE,
    DEFAULT_FONT_SIZE, DEFAULT_SCROLLBACK_HISTORY,
};

/// Mirrors `AlacrittyConfig`'s shape but leaves every leaf unset (`None`)
/// when the file doesn't mention it, instead of filling in Alacritty's
/// documented default immediately. Filling defaults per-layer would make an
/// import's explicit value get silently overwritten by a later, unrelated
/// layer that simply never mentions that field — the same bug `colors.normal`
/// already avoids by staying `Option<AnsiPalette>` in the public struct.
/// Defaults are only filled once, in `finalize`, after every layer merges.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PartialConfig {
    general: PartialGeneral,
    font: PartialFontConfig,
    colors: ColorsConfig,
    cursor: PartialCursorConfig,
    scrolling: PartialScrollingConfig,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PartialGeneral {
    import: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PartialFontConfig {
    normal: FontFace,
    size: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PartialCursorStyle {
    shape: Option<String>,
    blinking: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PartialCursorConfig {
    style: PartialCursorStyle,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PartialScrollingConfig {
    history: Option<u32>,
}

/// Read and resolve `path` and every file it (transitively) imports via
/// `general.import`. `Ok(None)` only when `path` itself does not exist — the
/// common case, not an error. An import that is missing or fails to parse
/// *is* an error: unlike the root file, the user explicitly named it.
///
/// Returns the fully merged `AlacrittyConfig` and every file path that was
/// actually read, in resolution order (root first), for the caller's file
/// watcher.
pub fn resolve_alacritty_config(
    path: &Path,
) -> Result<Option<(AlacrittyConfig, Vec<PathBuf>)>, String> {
    let Some(raw) = read_to_string_or_none(path)? else {
        return Ok(None);
    };
    let mut visited = HashSet::new();
    let (partial, touched) = resolve_layer(path, &raw, &mut visited)?;
    Ok(Some((finalize(partial), touched)))
}

/// Resolve one file's own layer plus every file it imports, most-recently
/// merged last so this file's own fields win. `visited` guards against import
/// cycles (a file that imports itself, directly or through others): a path
/// already in `visited` is skipped rather than re-read, so a cycle degrades
/// to "that layer contributes nothing the second time" instead of looping.
fn resolve_layer(
    path: &Path,
    raw: &str,
    visited: &mut HashSet<PathBuf>,
) -> Result<(PartialConfig, Vec<PathBuf>), String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        return Ok((PartialConfig::default(), Vec::new()));
    }

    let own: PartialConfig =
        toml::from_str(raw).map_err(|e| format!("failed to parse {}: {e}", path.display()))?;
    let mut touched = vec![path.to_path_buf()];
    let mut merged = PartialConfig::default();

    let import_dir = path.parent().unwrap_or_else(|| Path::new("."));
    for import in &own.general.import {
        let import_path = resolve_import_path(import, import_dir)?;
        let Some(import_raw) = read_to_string_or_none(&import_path)? else {
            return Err(format!(
                "imported file not found: {}",
                import_path.display()
            ));
        };
        let (import_partial, import_touched) = resolve_layer(&import_path, &import_raw, visited)?;
        merged = merge_partial(merged, import_partial);
        touched.extend(import_touched);
    }

    merged = merge_partial(merged, own);
    Ok((merged, touched))
}

/// Expand a leading `~` and resolve a relative path against the importing
/// file's own directory — matching Alacritty's own `general.import`
/// resolution, not the service process's working directory.
fn resolve_import_path(raw: &str, importer_dir: &Path) -> Result<PathBuf, String> {
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        let home = dirs::home_dir()
            .ok_or_else(|| "cannot expand '~' in import path: no home directory".to_string())?;
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    Ok(if expanded.is_absolute() {
        expanded
    } else {
        importer_dir.join(expanded)
    })
}

/// `None` only for a missing file — the caller decides whether that's normal
/// (root) or an error (an explicit import).
fn read_to_string_or_none(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

/// `overlay`'s fields win wherever it sets them; `base` fills the rest.
/// Called with imports merged in list order (each subsequent import is
/// `overlay` over the ones before it), then once more with the importing
/// file's own fields as the final `overlay`.
fn merge_partial(base: PartialConfig, overlay: PartialConfig) -> PartialConfig {
    PartialConfig {
        general: PartialGeneral::default(), // never read past this layer
        font: PartialFontConfig {
            normal: FontFace {
                family: overlay.font.normal.family.or(base.font.normal.family),
                style: overlay.font.normal.style.or(base.font.normal.style),
            },
            size: overlay.font.size.or(base.font.size),
        },
        colors: ColorsConfig {
            primary: PrimaryColors {
                foreground: overlay
                    .colors
                    .primary
                    .foreground
                    .or(base.colors.primary.foreground),
                background: overlay
                    .colors
                    .primary
                    .background
                    .or(base.colors.primary.background),
            },
            cursor: CursorColors {
                text: overlay.colors.cursor.text.or(base.colors.cursor.text),
                cursor: overlay.colors.cursor.cursor.or(base.colors.cursor.cursor),
            },
            normal: overlay.colors.normal.or(base.colors.normal),
            bright: overlay.colors.bright.or(base.colors.bright),
        },
        cursor: PartialCursorConfig {
            style: PartialCursorStyle {
                shape: overlay.cursor.style.shape.or(base.cursor.style.shape),
                blinking: overlay.cursor.style.blinking.or(base.cursor.style.blinking),
            },
        },
        scrolling: PartialScrollingConfig {
            history: overlay.scrolling.history.or(base.scrolling.history),
        },
    }
}

/// Fill whatever no layer set with Alacritty's own documented defaults — the
/// same constants the single-file path already used.
fn finalize(partial: PartialConfig) -> AlacrittyConfig {
    AlacrittyConfig {
        font: FontConfig {
            normal: partial.font.normal,
            size: partial.font.size.unwrap_or(DEFAULT_FONT_SIZE),
        },
        colors: partial.colors,
        cursor: CursorConfig {
            style: CursorStyle {
                shape: partial
                    .cursor
                    .style
                    .shape
                    .unwrap_or_else(|| DEFAULT_CURSOR_SHAPE.to_string()),
                blinking: partial
                    .cursor
                    .style
                    .blinking
                    .unwrap_or_else(|| DEFAULT_CURSOR_BLINKING.to_string()),
            },
        },
        scrolling: ScrollingConfig {
            history: partial
                .scrolling
                .history
                .unwrap_or(DEFAULT_SCROLLBACK_HISTORY),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp_toml(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn missing_root_file_is_not_an_error() {
        let path = std::env::temp_dir().join("definitely-does-not-exist-alacritty.toml");
        assert_eq!(resolve_alacritty_config(&path), Ok(None));
    }

    #[test]
    fn malformed_root_file_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp_toml(dir.path(), "alacritty.toml", "this is not [ valid");
        let result = resolve_alacritty_config(&path);
        assert!(result.is_err(), "expected an error, got {result:?}");
    }

    #[test]
    fn empty_file_gets_alacrittys_real_documented_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp_toml(dir.path(), "alacritty.toml", "");
        let (config, touched) = resolve_alacritty_config(&path).unwrap().unwrap();
        assert_eq!(config.scrolling.history, 10_000);
        assert_eq!(config.cursor.style.shape, "Block");
        assert_eq!(config.cursor.style.blinking, "Off");
        assert_eq!(config.font.size, 11.25);
        assert_eq!(config.font.normal.family, None);
        assert_eq!(config.colors.normal, None);
        assert_eq!(touched, vec![path]);
    }

    #[test]
    fn partial_file_only_overrides_what_it_sets() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "[cursor.style]\nshape = \"Beam\"\n",
        );
        let (config, _touched) = resolve_alacritty_config(&path).unwrap().unwrap();
        assert_eq!(config.cursor.style.shape, "Beam");
        assert_eq!(config.cursor.style.blinking, "Off");
        assert_eq!(config.scrolling.history, 10_000);
    }

    #[test]
    fn full_file_is_parsed_field_for_field() {
        let dir = tempfile::tempdir().unwrap();
        // `r##"..."##`, not `r#"..."#`: the content contains `"#` sequences
        // (every `"#hexcolor"` value), which would otherwise close a
        // single-hash raw string early.
        let path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
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
        let (config, touched) = resolve_alacritty_config(&path).unwrap().unwrap();
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
        assert_eq!(touched, vec![path]);
    }

    #[test]
    fn one_level_import_is_merged_under_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let font_path = write_temp_toml(
            dir.path(),
            "font.toml",
            "[font.normal]\nfamily = \"Iosevka Nerd Font Mono\"\n",
        );
        let root_path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "general.import = [\"font.toml\"]\n[scrolling]\nhistory = 5000\n",
        );
        let (config, touched) = resolve_alacritty_config(&root_path).unwrap().unwrap();
        assert_eq!(
            config.font.normal.family.as_deref(),
            Some("Iosevka Nerd Font Mono"),
            "font.family should come from the imported file"
        );
        assert_eq!(
            config.scrolling.history, 5000,
            "root's own field should still apply"
        );
        assert_eq!(touched, vec![root_path, font_path]);
    }

    #[test]
    fn root_field_wins_over_an_imported_value_for_the_same_field() {
        let dir = tempfile::tempdir().unwrap();
        write_temp_toml(dir.path(), "font.toml", "[font]\nsize = 12\n");
        let root_path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "general.import = [\"font.toml\"]\n[font]\nsize = 20\n",
        );
        let (config, _touched) = resolve_alacritty_config(&root_path).unwrap().unwrap();
        assert_eq!(
            config.font.size, 20.0,
            "the importing file's own value must win over its import"
        );
    }

    #[test]
    fn later_import_wins_over_an_earlier_one_for_the_same_field() {
        let dir = tempfile::tempdir().unwrap();
        write_temp_toml(dir.path(), "a.toml", "[font]\nsize = 10\n");
        write_temp_toml(dir.path(), "b.toml", "[font]\nsize = 20\n");
        let root_path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "general.import = [\"a.toml\", \"b.toml\"]\n",
        );
        let (config, _touched) = resolve_alacritty_config(&root_path).unwrap().unwrap();
        assert_eq!(
            config.font.size, 20.0,
            "later entries in general.import must override earlier ones"
        );
    }

    #[test]
    fn nested_import_two_levels_deep_is_resolved() {
        let dir = tempfile::tempdir().unwrap();
        write_temp_toml(
            dir.path(),
            "palette.toml",
            "[colors.primary]\nbackground = \"#1e1e2e\"\n",
        );
        write_temp_toml(
            dir.path(),
            "theme.toml",
            "general.import = [\"palette.toml\"]\n[colors.primary]\nforeground = \"#cdd6f4\"\n",
        );
        let root_path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "general.import = [\"theme.toml\"]\n",
        );
        let (config, touched) = resolve_alacritty_config(&root_path).unwrap().unwrap();
        assert_eq!(config.colors.primary.background.as_deref(), Some("#1e1e2e"));
        assert_eq!(config.colors.primary.foreground.as_deref(), Some("#cdd6f4"));
        assert_eq!(
            touched.len(),
            3,
            "root + theme.toml + palette.toml should all be touched"
        );
    }

    #[test]
    fn import_cycle_does_not_loop_forever() {
        let dir = tempfile::tempdir().unwrap();
        write_temp_toml(
            dir.path(),
            "b.toml",
            "general.import = [\"a.toml\"]\n[font]\nsize = 12\n",
        );
        let root_path = write_temp_toml(
            dir.path(),
            "a.toml",
            "general.import = [\"b.toml\"]\n[scrolling]\nhistory = 3000\n",
        );
        let (config, _touched) = resolve_alacritty_config(&root_path).unwrap().unwrap();
        // a.toml (root) is visited first, so b.toml's re-import of a.toml is
        // the one that gets skipped -- a.toml's own fields still apply.
        assert_eq!(config.scrolling.history, 3000);
    }

    #[test]
    fn missing_import_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "general.import = [\"does-not-exist.toml\"]\n",
        );
        let result = resolve_alacritty_config(&root_path);
        assert!(result.is_err(), "expected an error, got {result:?}");
    }

    #[test]
    fn malformed_import_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        write_temp_toml(dir.path(), "broken.toml", "this is not [ valid");
        let root_path = write_temp_toml(
            dir.path(),
            "alacritty.toml",
            "general.import = [\"broken.toml\"]\n",
        );
        let result = resolve_alacritty_config(&root_path);
        assert!(result.is_err(), "expected an error, got {result:?}");
    }

    #[test]
    fn resolve_import_path_keeps_an_absolute_path_as_is() {
        let importer_dir = Path::new("/does/not/matter");
        let resolved = resolve_import_path("/abs/theme.toml", importer_dir).unwrap();
        assert_eq!(resolved, PathBuf::from("/abs/theme.toml"));
    }

    #[test]
    fn resolve_import_path_is_relative_to_the_importing_files_directory() {
        let importer_dir = Path::new("/home/user/.config/alacritty");
        let resolved = resolve_import_path("themes/font.toml", importer_dir).unwrap();
        assert_eq!(
            resolved,
            PathBuf::from("/home/user/.config/alacritty/themes/font.toml")
        );
    }

    #[test]
    fn resolve_import_path_expands_a_leading_tilde_to_home() {
        let home = dirs::home_dir().expect("test environment must have a resolvable home dir");
        let importer_dir = Path::new("/does/not/matter");
        let resolved =
            resolve_import_path("~/.config/alacritty/themes/font.toml", importer_dir).unwrap();
        assert_eq!(resolved, home.join(".config/alacritty/themes/font.toml"));
    }
}
