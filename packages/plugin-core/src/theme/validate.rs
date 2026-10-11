//! The validation gate every theme passes before it can be applied.
//!
//! Four checks, in order:
//! 1. **Schema** — the document parses, and `cssVars` holds known token keys:
//!    every required one, no unknown ones, and any of the optional chrome
//!    tokens the theme chose to color.
//! 2. **Colors** — every value resolves to a CSS color. Single-level
//!    `var(--other-token)` references are resolved first, because that is how
//!    the first-party themes are authored (`--editor-fg: var(--code-fg)`) and a
//!    duplicate should stay editable in the same idiom.
//! 3. **Contrast** — key foreground/background pairs clear WCAG AA.
//! 4. **Chrome** — the chassis/tabs/texture vocabulary in `chrome.rs`: known
//!    enum values, colors that parse, numbers in range, a texture asset that
//!    names a file in the theme's own folder.
//!
//! A theme that fails any of them is listed in the gallery with its issues and
//! never registered, so a bad file can't leave the UI unpainted.

use std::collections::BTreeMap;

use super::color::{contrast_ratio, parse_color, LinearRgba};
use super::models::{ThemeDocument, ThemeIssue};
use super::tokens::{is_known_token, CONTRAST_PAIRS, REQUIRED_TOKENS};

/// Values longer than this are not colors; the cap also bounds what the
/// renderer ever injects into a stylesheet.
pub const MAX_VALUE_LEN: usize = 256;
pub const MAX_LABEL_LEN: usize = 64;

pub fn validate(document: &ThemeDocument) -> Vec<ThemeIssue> {
    let mut issues = validate_label(document);
    issues.extend(validate_keys(&document.css_vars));
    let resolved = resolve_and_parse(&document.css_vars, &mut issues);
    issues.extend(validate_contrast(&resolved));
    issues.extend(validate_xterm(document));
    issues.extend(super::chrome::validate(&document.chrome));
    issues
}

fn validate_label(document: &ThemeDocument) -> Vec<ThemeIssue> {
    let label = document.label.trim();
    if label.is_empty() {
        return vec![ThemeIssue::document("`label` must not be empty")];
    }
    if label.chars().count() > MAX_LABEL_LEN {
        return vec![ThemeIssue::document(format!(
            "`label` must be at most {MAX_LABEL_LEN} characters"
        ))];
    }
    Vec::new()
}

fn validate_keys(css_vars: &BTreeMap<String, String>) -> Vec<ThemeIssue> {
    let mut issues = Vec::new();
    for key in css_vars.keys() {
        if !is_known_token(key.as_str()) {
            issues.push(ThemeIssue::new(
                key,
                "unknown design token — a theme may only set the documented tokens",
            ));
        }
    }
    for token in REQUIRED_TOKENS {
        if !css_vars.contains_key(*token) {
            issues.push(ThemeIssue::new(
                *token,
                "missing — a theme must define every design token",
            ));
        }
    }
    issues
}

/// Resolve `var(--token)` indirection, then parse each value as a color.
/// Returns the tokens that resolved, so the contrast pass can use them.
fn resolve_and_parse(
    css_vars: &BTreeMap<String, String>,
    issues: &mut Vec<ThemeIssue>,
) -> BTreeMap<String, LinearRgba> {
    let mut resolved = BTreeMap::new();
    for (key, raw) in css_vars {
        if !is_known_token(key.as_str()) {
            continue;
        }
        if raw.len() > MAX_VALUE_LEN {
            issues.push(ThemeIssue::new(
                key,
                format!("value must be at most {MAX_VALUE_LEN} characters"),
            ));
            continue;
        }
        match resolve_value(css_vars, raw) {
            Ok(value) => match parse_color(&value) {
                Ok(color) => {
                    resolved.insert(key.clone(), color);
                }
                Err(error) => issues.push(ThemeIssue::new(key, error.to_string())),
            },
            Err(message) => issues.push(ThemeIssue::new(key, message)),
        }
    }
    resolved
}

/// Follow a chain of `var(--token)` references to a literal value. Bounded, so
/// a self-referencing or cyclic file reports a clear error instead of hanging.
fn resolve_value(css_vars: &BTreeMap<String, String>, raw: &str) -> Result<String, String> {
    const MAX_HOPS: usize = 8;
    let mut value = raw.trim().to_string();
    for _ in 0..MAX_HOPS {
        let Some(target) = var_reference(&value) else {
            return Ok(value);
        };
        if !is_known_token(target.as_str()) {
            return Err(format!("`var({target})` is not a known design token"));
        }
        let Some(next) = css_vars.get(&target) else {
            return Err(format!("`var({target})` is not defined by this theme"));
        };
        value = next.trim().to_string();
    }
    Err("`var()` references form a cycle".to_string())
}

/// The token name in a bare `var(--x)` value, if that's all the value is.
/// Anything richer (a fallback, a `var()` nested in a function) is left alone
/// and will be reported by the color parser.
fn var_reference(value: &str) -> Option<String> {
    let inner = value.strip_prefix("var(")?.strip_suffix(')')?.trim();
    if !inner.starts_with("--") || inner.contains(',') || inner.contains('(') {
        return None;
    }
    Some(inner.to_string())
}

fn validate_contrast(resolved: &BTreeMap<String, LinearRgba>) -> Vec<ThemeIssue> {
    let mut issues = Vec::new();
    // Surface tokens are routinely translucent — Frost's `--card` is a glass
    // overlay, not a fill — so a surface is measured as it is actually seen:
    // composited over the page background. Measuring `--card` in isolation
    // reports 1:1 for every glass theme, which is noise, not a finding.
    let page = resolved.get("--background").copied();
    for pair in CONTRAST_PAIRS {
        let (Some(fg), Some(bg)) = (resolved.get(pair.foreground), resolved.get(pair.background))
        else {
            // One of the two already failed to parse; that error is the useful
            // one, so don't pile a contrast complaint on top of it.
            continue;
        };
        let bg = match page {
            Some(page) => bg.over(page),
            None => *bg,
        };
        let ratio = contrast_ratio(*fg, bg);
        // The epsilon covers the rounding in the reported "{ratio:.2}:1" — a
        // theme sitting exactly on a threshold shouldn't be told it is below a
        // number it visibly equals.
        if ratio + 0.005 < pair.min_ratio {
            issues.push(ThemeIssue::new(
                pair.foreground,
                format!(
                    "contrast against `{}` is {ratio:.2}:1, below the {:.1}:1 minimum",
                    pair.background, pair.min_ratio
                ),
            ));
        }
    }
    issues
}

/// Every entry in the xterm palette must parse as a color too — the terminal is
/// canvas-rendered, so a bad value there paints nothing rather than falling back.
///
/// Serialized rather than field-matched so the list can't drift from the struct.
fn validate_xterm(document: &ThemeDocument) -> Vec<ThemeIssue> {
    let Ok(serde_json::Value::Object(palette)) = serde_json::to_value(&document.xterm) else {
        return vec![ThemeIssue::document("`xterm` palette is not an object")];
    };
    palette
        .iter()
        .filter_map(|(name, value)| {
            let text = value.as_str()?;
            parse_color(text)
                .err()
                .map(|error| ThemeIssue::new(format!("xterm.{name}"), error.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::test_support::valid_document;

    fn messages(document: &ThemeDocument) -> Vec<String> {
        validate(document)
            .iter()
            .map(ThemeIssue::describe)
            .collect()
    }

    #[test]
    fn a_duplicated_theme_validates_clean() {
        assert_eq!(validate(&valid_document()).len(), 0);
    }

    #[test]
    fn rejects_the_hsl_var_channel_bug() {
        // The regression this gate exists for: `--background: hsl(var(--x))`
        // treated a color *value* as an HSL channel triple and silently painted
        // nothing. It must now be caught before the theme can be applied.
        let mut document = valid_document();
        document
            .css_vars
            .insert("--background".into(), "hsl(var(--foreground))".into());
        assert!(
            messages(&document)
                .iter()
                .any(|m| m.starts_with("--background")),
            "{:?}",
            messages(&document)
        );
    }

    #[test]
    fn rejects_unknown_and_missing_tokens() {
        let mut document = valid_document();
        document.css_vars.insert("--evil".into(), "#fff".into());
        document.css_vars.remove("--ring");
        let messages = messages(&document);
        assert!(messages.iter().any(|m| m.contains("--evil: unknown")));
        assert!(messages.iter().any(|m| m.contains("--ring: missing")));
    }

    /// The chrome tokens a theme may set but needn't: present, they are held to
    /// the same standard as any other color; absent, the theme is still valid.
    #[test]
    fn accepts_the_optional_chrome_tokens_without_requiring_them() {
        use crate::theme::tokens::OPTIONAL_TOKENS;

        assert_eq!(validate(&valid_document()).len(), 0);

        let mut document = valid_document();
        for token in OPTIONAL_TOKENS {
            document
                .css_vars
                .insert((*token).into(), "oklch(0.3 0.01 260)".into());
        }
        assert_eq!(messages(&document), Vec::<String>::new());

        document
            .css_vars
            .insert("--tab-track-bg".into(), "not-a-color".into());
        assert!(
            messages(&document)
                .iter()
                .any(|m| m.starts_with("--tab-track-bg")),
            "{:?}",
            messages(&document)
        );
    }

    /// The shadows the chrome layer also reads are `box-shadow` values, not
    /// colors, so they stay out of the vocabulary rather than being accepted
    /// and then failing to parse.
    #[test]
    fn still_rejects_the_chrome_tokens_that_are_not_colors() {
        let mut document = valid_document();
        document
            .css_vars
            .insert("--tab-active-shadow".into(), "0 1px 2px #000".into());
        assert!(messages(&document)
            .iter()
            .any(|m| m.contains("--tab-active-shadow: unknown")));
    }

    #[test]
    fn resolves_var_references_between_tokens() {
        let mut document = valid_document();
        document
            .css_vars
            .insert("--editor-fg".into(), "var(--code-fg)".into());
        assert_eq!(validate(&document).len(), 0);
    }

    #[test]
    fn rejects_var_cycles_and_dangling_references() {
        let mut document = valid_document();
        document
            .css_vars
            .insert("--editor-fg".into(), "var(--code-fg)".into());
        document
            .css_vars
            .insert("--code-fg".into(), "var(--editor-fg)".into());
        assert!(messages(&document).iter().any(|m| m.contains("cycle")));

        let mut document = valid_document();
        document
            .css_vars
            .insert("--editor-fg".into(), "var(--not-a-token)".into());
        assert!(messages(&document)
            .iter()
            .any(|m| m.contains("not a known design token")));
    }

    #[test]
    fn rejects_illegible_foreground_background_pairs() {
        let mut document = valid_document();
        document
            .css_vars
            .insert("--foreground".into(), "#111111".into());
        let messages = messages(&document);
        assert!(
            messages
                .iter()
                .any(|m| m.starts_with("--foreground") && m.contains("below the 4.5:1 minimum")),
            "{messages:?}"
        );
    }

    #[test]
    fn rejects_an_unparseable_xterm_color() {
        let mut document = valid_document();
        document.xterm.red = "not-a-color".into();
        assert!(messages(&document).iter().any(|m| m.contains("xterm.red")));
    }

    #[test]
    fn rejects_an_empty_label() {
        let mut document = valid_document();
        document.label = "   ".into();
        assert!(messages(&document).iter().any(|m| m.contains("label")));
    }
}
