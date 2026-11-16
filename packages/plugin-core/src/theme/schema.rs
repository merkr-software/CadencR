//! The JSON Schema Cadencr writes beside every theme file.
//!
//! A theme is edited by whoever opens it — in practice an agent with
//! `theme.json` in one pane and nothing else to go on. The document's shape is
//! obvious from its contents for colors (the keys are CSS custom properties) and
//! nearly opaque for [`chrome`](super::chrome): seeing `"chassis": "rail"` says
//! nothing about `flat` being the alternative, about `blend` being a closed set
//! of eight, or about what range a halo's `blur` may sit in.
//!
//! So the vocabulary travels with the file. `theme.json` carries a `$schema`
//! pointing at the copy in its own folder, which makes an editor complete and
//! check the document as it is typed — and gives an agent something to read
//! before it guesses.
//!
//! Generated rather than hand-written, from the same constants the validator
//! uses. A schema that called a value legal while the app refused to paint it
//! would be worse than no schema at all.

mod definitions;
#[cfg(test)]
use definitions::asset_pattern;
use definitions::defs;
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::chrome::{
    Range, ThemeBlend, ThemeChassis, ThemeImageFit, ThemeTabs, ASSET_EXTENSIONS, GRAIN_SCALE,
    HALO_BLUR, HALO_DRIFT, HALO_OFFSET, HALO_SIZE, IMAGE_SCALE, MAX_ASSET_NAME_LEN, MAX_HALOS,
    OPACITY,
};
use super::tokens::{OPTIONAL_TOKENS, REQUIRED_TOKENS};
use super::validate::MAX_LABEL_LEN;

pub const SCHEMA_FILE_NAME: &str = "theme.schema.json";

/// What a theme file's own `$schema` points at. Relative, and to the copy in the
/// theme's own folder: an editor resolving it must not need the network, and a
/// user on a version of Cadencr older or newer than a shared theme should get
/// the vocabulary *their* app enforces.
pub const SCHEMA_REFERENCE: &str = "./theme.schema.json";

/// The xterm palette's keys, in the order the struct declares them. Mirrors
/// `XtermPalette`; a test fails if the two ever drift.
const XTERM_KEYS: &[&str] = &[
    "background",
    "foreground",
    "cursor",
    "cursorAccent",
    "selectionBackground",
    "selectionForeground",
    "selectionInactiveBackground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

const COLOR: &str = "A CSS color: `#rrggbb`, `rgb(…)`, `hsl(…)`, `oklch(…)`, \
                     or the same with an alpha channel.";

/// Optional tokens need the color rule *and* the reason they are optional —
/// this string is what an editor shows on hover for a key the theme does not
/// have yet, so it has to answer "should I add this?" on its own.
const OPTIONAL: &str = "Optional. Colors a shape this theme opts into via \
                        `chrome`; leave it out and Cadencr derives one from the \
                        palette. A CSS color, as above.";

/// The schema as a formatted document, ready to write to disk.
pub fn render() -> String {
    let json = serde_json::to_string_pretty(&document()).expect("a JSON value serializes");
    format!("{json}\n")
}

/// The serialized names of an enum's variants, in declaration order — what the
/// schema and the reference doc both list.
pub fn names<T: Serialize>(values: &[T]) -> Vec<String> {
    values
        .iter()
        .map(|value| {
            serde_json::to_value(value)
                .ok()
                .and_then(|json| json.as_str().map(str::to_string))
                .expect("a theme enum serializes as a string")
        })
        .collect()
}

fn document() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Cadencr theme",
        "description": "A Cadencr color theme. Saving this file repaints the \
                        running app; a file that fails validation is listed in \
                        the theme library with its problems and never applied.",
        "type": "object",
        "required": ["label", "appearance", "cssVars", "xterm"],
        "properties": {
            "$schema": {
                "type": "string",
                "description": "Points at this schema, kept beside the theme by Cadencr.",
            },
            "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_LABEL_LEN,
                "description": "The theme's name in the library. Renaming it \
                                also renames this project in the sidebar.",
            },
            "appearance": {
                "enum": ["light", "dark"],
                "description": "Drives `color-scheme`, the logo variant and the \
                                editor's fallback styling.",
            },
            "cssVars": css_vars(),
            "xterm": xterm(),
            "chrome": { "$ref": "#/$defs/chrome" },
        },
        "$defs": defs(),
    })
}

/// The closed token set. Enumerated rather than left open so an editor completes
/// the names and flags a typo — `validate` rejects an unknown token, and a theme
/// missing a required one is never applied.
///
/// The optional tier is listed in `properties` but not in `required`, which is
/// what makes it discoverable: an editor offers `--tab-track-bg` in completion
/// on a theme that has never heard of it, and nothing complains when it stays
/// absent.
fn css_vars() -> Value {
    let describe = |token: &&str, description: &str| {
        (
            (*token).to_string(),
            json!({ "type": "string", "description": description }),
        )
    };
    let properties: Map<String, Value> = REQUIRED_TOKENS
        .iter()
        .map(|token| describe(token, COLOR))
        .chain(
            OPTIONAL_TOKENS
                .iter()
                .map(|token| describe(token, OPTIONAL)),
        )
        .collect();
    json!({
        "type": "object",
        "description": "The design tokens this theme defines. Every required one \
                        must be present and no unknown key is allowed; the chrome \
                        tokens are optional. A value may be a single \
                        `var(--other-token)` reference.",
        "required": REQUIRED_TOKENS,
        "properties": properties,
        "additionalProperties": false,
    })
}

fn xterm() -> Value {
    let properties: Map<String, Value> = XTERM_KEYS
        .iter()
        .map(|key| {
            (
                (*key).to_string(),
                json!({ "type": "string", "description": COLOR }),
            )
        })
        .collect();
    json!({
        "type": "object",
        "description": "The terminal palette. xterm.js is canvas-rendered and \
                        cannot read CSS, so every theme spells this out.",
        "required": XTERM_KEYS,
        "properties": properties,
        "additionalProperties": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::chrome::{ThemeChrome, ThemeGrain, ThemeHalo, ThemeImage};
    use crate::theme::test_support::valid_document;
    use regex_lite::Regex;

    /// The keys a value serializes to — what the schema has to describe.
    fn keys_of<T: Serialize>(value: &T) -> Vec<String> {
        let serde_json::Value::Object(map) = serde_json::to_value(value).expect("serializes")
        else {
            panic!("not an object");
        };
        let mut keys: Vec<_> = map.keys().cloned().collect();
        keys.sort();
        keys
    }

    fn properties(schema: &Value, pointer: &str) -> Vec<String> {
        let object = schema
            .pointer(pointer)
            .unwrap_or_else(|| panic!("{pointer} is in the schema"));
        let mut keys: Vec<_> = object["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("{pointer} has properties"))
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    /// The guard that keeps the schema honest: a field added to any of these
    /// structs shows up in the serialized document, and the schema has to
    /// describe it or this fails. Without it the schema would quietly go stale
    /// and start calling a legal document invalid.
    #[test]
    fn every_serialized_field_is_described() {
        let schema = document();
        let mut expected = keys_of(&valid_document());
        // `$schema` is optional in the document and absent from a plain one.
        expected.push("$schema".to_string());
        expected.sort();
        let mut described = properties(&schema, "");
        described.sort();
        assert_eq!(described, expected);

        assert_eq!(
            properties(&schema, "/$defs/chrome"),
            keys_of(&ThemeChrome::default())
        );
        assert_eq!(
            properties(&schema, "/$defs/texture"),
            keys_of(&ThemeChrome::default().texture)
        );
        assert_eq!(properties(&schema, "/$defs/halo"), keys_of(&halo_value()));
        assert_eq!(properties(&schema, "/$defs/grain"), keys_of(&grain_value()));
        assert_eq!(properties(&schema, "/$defs/image"), keys_of(&image_value()));
    }

    #[test]
    fn the_xterm_key_list_matches_the_palette() {
        assert_eq!(
            {
                let mut keys = XTERM_KEYS.to_vec();
                keys.sort();
                keys
            },
            keys_of(&valid_document().xterm),
            "the schema's xterm keys drifted from `XtermPalette`"
        );
    }

    #[test]
    fn the_token_list_is_enumerated_so_an_editor_can_complete_it() {
        let schema = document();
        let tokens = properties(&schema, "/properties/cssVars");
        assert_eq!(tokens.len(), REQUIRED_TOKENS.len() + OPTIONAL_TOKENS.len());
        assert!(tokens.contains(&"--background".to_string()));
        assert_eq!(
            schema["properties"]["cssVars"]["additionalProperties"],
            json!(false),
            "validate rejects unknown tokens, so the schema must too"
        );
    }

    /// The optional tier has to be offered *and* not demanded — listed under
    /// `properties` so completion knows it exists, absent from `required` so a
    /// theme that never draws that chrome is not asked to color it.
    #[test]
    fn the_optional_tokens_are_offered_without_being_demanded() {
        let schema = document();
        let required = schema["properties"]["cssVars"]["required"]
            .as_array()
            .expect("a required list")
            .iter()
            .map(|value| value.as_str().expect("a token name").to_string())
            .collect::<Vec<_>>();
        let offered = properties(&schema, "/properties/cssVars");
        for token in OPTIONAL_TOKENS {
            assert!(offered.contains(&(*token).to_string()), "{token}");
            assert!(!required.contains(&(*token).to_string()), "{token}");
        }
        assert_eq!(required.len(), REQUIRED_TOKENS.len());
    }

    #[test]
    fn enum_values_are_the_ones_the_document_actually_accepts() {
        let schema = document();
        for (pointer, values) in [
            ("/$defs/chrome/properties/chassis", names(ThemeChassis::ALL)),
            ("/$defs/chrome/properties/tabs", names(ThemeTabs::ALL)),
            ("/$defs/grain/properties/blend", names(ThemeBlend::ALL)),
            ("/$defs/image/properties/fit", names(ThemeImageFit::ALL)),
        ] {
            let listed = schema.pointer(pointer).expect(pointer)["enum"]
                .as_array()
                .expect("an enum list")
                .clone();
            assert_eq!(listed, values.iter().map(|v| json!(v)).collect::<Vec<_>>());
        }
    }

    /// A completion the schema offers has to be a value the app accepts —
    /// otherwise the file's own schema is talking the editor into a broken theme.
    #[test]
    fn every_offered_chassis_and_tab_value_parses() {
        for chassis in names(ThemeChassis::ALL) {
            for tabs in names(ThemeTabs::ALL) {
                let json = json!({ "chassis": chassis, "tabs": tabs }).to_string();
                serde_json::from_str::<ThemeChrome>(&json)
                    .unwrap_or_else(|e| panic!("{json}: {e}"));
            }
        }
    }

    /// The asset pattern is the schema's half of the traversal gate; it has to
    /// agree with `chrome::validate` on the same names.
    #[test]
    fn the_asset_pattern_accepts_and_rejects_what_validate_does() {
        let pattern = Regex::new(&asset_pattern()).expect("a valid regex");
        for accepted in ["paper.png", "a.b.webp", "grain-2.SVG", "x_1.avif"] {
            assert!(pattern.is_match(accepted), "{accepted} must be accepted");
        }
        for rejected in [
            "../../.ssh/id_rsa.png",
            "sub/dir.png",
            ".hidden.png",
            "a..b.png",
            "https://example.com/x.png",
            "notes.txt",
            "",
        ] {
            assert!(!pattern.is_match(rejected), "{rejected} must be rejected");
        }
    }

    #[test]
    fn ranges_come_from_the_validator_rather_than_being_retyped() {
        let schema = document();
        let blur = &schema["$defs"]["halo"]["properties"]["blur"];
        assert_eq!(blur["minimum"], json!(HALO_BLUR.0));
        assert_eq!(blur["maximum"], json!(HALO_BLUR.1));
        assert_eq!(
            schema["$defs"]["texture"]["properties"]["halos"]["maxItems"],
            json!(MAX_HALOS)
        );
    }

    #[test]
    fn renders_as_a_json_document_ending_in_a_newline() {
        let rendered = render();
        assert!(rendered.ends_with("}\n"), "{}", &rendered[..40]);
        serde_json::from_str::<Value>(&rendered).expect("parses");
    }

    fn halo_value() -> ThemeHalo {
        ThemeHalo {
            color: "#ffffff".into(),
            size: 72.0,
            x: 28.0,
            y: 32.0,
            blur: 80.0,
            opacity: 0.5,
            drift: 28.0,
        }
    }

    fn grain_value() -> ThemeGrain {
        ThemeGrain {
            color: "#9ea8c7".into(),
            opacity: 0.36,
            blend: ThemeBlend::Screen,
            scale: 180.0,
        }
    }

    fn image_value() -> ThemeImage {
        ThemeImage {
            asset: "paper.png".into(),
            opacity: 0.2,
            blend: ThemeBlend::Multiply,
            fit: ThemeImageFit::Tile,
            scale: 320.0,
        }
    }
}
