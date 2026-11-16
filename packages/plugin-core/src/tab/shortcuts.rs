//! `shortcuts`: the keyboard shortcuts a tab handles while it has focus.
//!
//! Keys use the desktop's shortcut tokens (`packages/desktop/src/lib/shortcuts/types.ts`).
//! Cadencr's own shortcuts always win: the host disables a declared shortcut
//! that collides with one of them, so nothing here can know about conflicts.

use std::collections::BTreeSet;

use super::issues::{TabFindings, TabIssueCode as Code};
use super::manifest::TabShortcut;
use super::validate::{is_label, text_within};

const MAX_SHORTCUTS: usize = 16;
const MAX_SHORTCUT_ID_LEN: usize = 32;
const MAX_SHORTCUT_DESCRIPTION_CHARS: usize = 80;

/// Modifier tokens: `mod` is ⌘ on macOS and Ctrl elsewhere.
const SHORTCUT_MODIFIERS: [&str; 4] = ["mod", "ctrl", "alt", "shift"];
/// One of these must be held: a bare or Shift-only key is typing.
const COMMAND_MODIFIERS: [&str; 3] = ["mod", "ctrl", "alt"];
/// Named non-modifier tokens; single lowercase letters and digits are the rest.
const NAMED_KEYS: [&str; 15] = [
    "enter",
    "escape",
    "space",
    "up",
    "down",
    "left",
    "right",
    "plus",
    "minus",
    "comma",
    "slash",
    "backtick",
    "backspace",
    "lbracket",
    "rbracket",
];

pub(super) fn validate(shortcuts: &[TabShortcut], findings: &mut TabFindings) {
    if shortcuts.len() > MAX_SHORTCUTS {
        findings.error(
            Code::ShortcutsTooMany,
            "shortcuts",
            format!("at most {MAX_SHORTCUTS} shortcuts"),
        );
    }
    let mut ids = BTreeSet::new();
    let mut chords = BTreeSet::new();
    for (index, shortcut) in shortcuts.iter().enumerate() {
        let at = |name: &str| format!("shortcuts[{index}].{name}");
        if !is_label(&shortcut.id, MAX_SHORTCUT_ID_LEN) {
            findings.error(
                Code::ShortcutIdInvalid,
                at("id"),
                format!(
                    "must be 1–{MAX_SHORTCUT_ID_LEN} lowercase letters, digits or inner hyphens"
                ),
            );
        } else if !ids.insert(shortcut.id.as_str()) {
            findings.error(
                Code::ShortcutIdDuplicate,
                at("id"),
                format!("`{}` is declared twice", shortcut.id),
            );
        }
        match chord(&shortcut.keys) {
            Err(reason) => findings.error(Code::ShortcutKeysInvalid, at("keys"), reason),
            Ok(chord) => {
                if !chords.insert(chord) {
                    findings.error(
                        Code::ShortcutKeysDuplicate,
                        at("keys"),
                        "another shortcut already uses these keys",
                    );
                }
            }
        }
        if !text_within(&shortcut.description, MAX_SHORTCUT_DESCRIPTION_CHARS) {
            findings.error(
                Code::ShortcutDescriptionInvalid,
                at("description"),
                format!("must be 1–{MAX_SHORTCUT_DESCRIPTION_CHARS} characters"),
            );
        }
    }
}

fn is_key_token(token: &str) -> bool {
    let single = token.len() == 1
        && token
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    let function = token.strip_prefix('f').is_some_and(|number| {
        !number.starts_with('0')
            && number.bytes().all(|byte| byte.is_ascii_digit())
            && number
                .parse::<u8>()
                .is_ok_and(|number| (1..=12).contains(&number))
    });
    single || function || NAMED_KEYS.contains(&token)
}

/// The chord's modifiers (sorted) and key, or why `keys` is not one.
fn chord(keys: &[String]) -> Result<(Vec<&str>, &str), String> {
    let mut modifiers = Vec::new();
    let mut key = None;
    for token in keys {
        let token = token.as_str();
        if SHORTCUT_MODIFIERS.contains(&token) {
            if modifiers.contains(&token) {
                return Err(format!("`{token}` is listed twice"));
            }
            modifiers.push(token);
        } else if is_key_token(token) {
            if key.replace(token).is_some() {
                return Err("exactly one key besides the modifiers".into());
            }
        } else {
            return Err(format!(
                "`{token}` is not a key: use mod, ctrl, alt, shift, a lowercase letter, a digit, f1–f12 or {}",
                NAMED_KEYS.join(", ")
            ));
        }
    }
    let Some(key) = key else {
        return Err("exactly one key besides the modifiers".into());
    };
    if !modifiers
        .iter()
        .any(|modifier| COMMAND_MODIFIERS.contains(modifier))
    {
        return Err("hold mod, ctrl or alt: a bare or Shift-only key is typing".into());
    }
    modifiers.sort_unstable();
    Ok((modifiers, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(id: &str, keys: &[&str]) -> TabShortcut {
        TabShortcut {
            id: id.into(),
            keys: keys.iter().map(|key| key.to_string()).collect(),
            description: "Refresh the list".into(),
        }
    }

    fn codes(shortcuts: &[TabShortcut]) -> Vec<&'static str> {
        let mut findings = TabFindings::default();
        validate(shortcuts, &mut findings);
        findings
            .errors
            .iter()
            .map(|issue| issue.code.as_str())
            .collect()
    }

    #[test]
    fn accepts_chords_with_a_command_modifier() {
        let shortcuts = [
            shortcut("refresh", &["mod", "shift", "r"]),
            shortcut("next", &["alt", "down"]),
            shortcut("details", &["ctrl", "f5"]),
            shortcut("first", &["mod", "1"]),
        ];
        assert!(codes(&shortcuts).is_empty());
    }

    #[test]
    fn refuses_typing_unknown_tokens_and_ambiguous_chords() {
        for keys in [
            &["r"][..],
            &["shift", "r"],
            &["mod", "R"],
            &["mod", "tab"],
            &["mod", "f13"],
            &["mod", "f+1"],
            &["mod", "f01"],
            &["mod", "a", "b"],
            &["mod", "shift"],
            &["mod", "mod", "a"],
        ] {
            assert_eq!(
                codes(&[shortcut("one", keys)]),
                ["SHORTCUT_KEYS_INVALID"],
                "{keys:?}"
            );
        }
    }

    #[test]
    fn ids_and_chords_are_unique_in_any_order() {
        let shortcuts = [
            shortcut("refresh", &["mod", "shift", "r"]),
            shortcut("refresh", &["mod", "e"]),
            shortcut("reload", &["shift", "mod", "r"]),
        ];
        assert_eq!(
            codes(&shortcuts),
            ["SHORTCUT_ID_DUPLICATE", "SHORTCUT_KEYS_DUPLICATE"]
        );
    }

    #[test]
    fn bounds_ids_descriptions_and_count() {
        let mut long = shortcut("-bad", &["mod", "e"]);
        long.description = "x".repeat(MAX_SHORTCUT_DESCRIPTION_CHARS + 1);
        assert_eq!(
            codes(&[long]),
            ["SHORTCUT_ID_INVALID", "SHORTCUT_DESCRIPTION_INVALID"]
        );
        let many: Vec<_> = (0..=MAX_SHORTCUTS)
            .map(|index| shortcut(&format!("s{index}"), &["mod", "alt", "a"]))
            .collect();
        assert_eq!(codes(&many)[0], "SHORTCUTS_TOO_MANY");
    }
}
