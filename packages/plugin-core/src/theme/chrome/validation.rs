use super::*;

/// The bounds every number in a texture has to sit inside.
///
/// Public and named because they are asserted in two places that must agree: the
/// validator below, which decides whether a theme can be applied, and the JSON
/// Schema written into the theme folder, which is what tells the editor — and
/// the agent — the range *before* the value is saved. A range that drifted
/// between the two would mean the file's own schema calls a value legal and the
/// app then refuses to paint it.
pub type Range = (f32, f32);

pub const HALO_SIZE: Range = (1.0, 400.0);
/// Halo centers may sit off-screen, which is how a field is anchored to an edge.
pub const HALO_OFFSET: Range = (-200.0, 200.0);
pub const HALO_BLUR: Range = (0.0, 400.0);
pub const HALO_DRIFT: Range = (0.0, 600.0);
pub const OPACITY: Range = (0.0, 1.0);
pub const GRAIN_SCALE: Range = (4.0, 2048.0);
pub const IMAGE_SCALE: Range = (4.0, 4096.0);

pub fn validate(chrome: &ThemeChrome) -> Vec<ThemeIssue> {
    let texture = &chrome.texture;
    let mut issues = Vec::new();

    if let Some(base) = &texture.base {
        check_color("chrome.texture.base", base, &mut issues);
    }
    if texture.halos.len() > MAX_HALOS {
        issues.push(ThemeIssue::new(
            "chrome.texture.halos",
            format!("at most {MAX_HALOS} halos — each one is a full-screen blurred layer"),
        ));
    }
    for (index, halo) in texture.halos.iter().enumerate() {
        validate_halo(index, halo, &mut issues);
    }
    if let Some(grain) = &texture.grain {
        check_color("chrome.texture.grain.color", &grain.color, &mut issues);
        check_range(
            "chrome.texture.grain.opacity",
            grain.opacity,
            OPACITY,
            &mut issues,
        );
        check_range(
            "chrome.texture.grain.scale",
            grain.scale,
            GRAIN_SCALE,
            &mut issues,
        );
    }
    if let Some(image) = &texture.image {
        validate_asset_name(&image.asset, &mut issues);
        check_range(
            "chrome.texture.image.opacity",
            image.opacity,
            OPACITY,
            &mut issues,
        );
        check_range(
            "chrome.texture.image.scale",
            image.scale,
            IMAGE_SCALE,
            &mut issues,
        );
    }
    issues
}

fn validate_halo(index: usize, halo: &ThemeHalo, issues: &mut Vec<ThemeIssue>) {
    let at = |field: &str| format!("chrome.texture.halos[{index}].{field}");
    check_color(&at("color"), &halo.color, issues);
    check_range(&at("size"), halo.size, HALO_SIZE, issues);
    check_range(&at("x"), halo.x, HALO_OFFSET, issues);
    check_range(&at("y"), halo.y, HALO_OFFSET, issues);
    check_range(&at("blur"), halo.blur, HALO_BLUR, issues);
    check_range(&at("opacity"), halo.opacity, OPACITY, issues);
    check_range(&at("drift"), halo.drift, HALO_DRIFT, issues);
}

/// An asset is a plain file name in the theme's own folder. Anything that could
/// name a file outside it — a separator, a `..`, a scheme — is not a name.
pub fn validate_asset_name(asset: &str, issues: &mut Vec<ThemeIssue>) {
    let field = "chrome.texture.image.asset";
    if asset.is_empty() || asset.len() > MAX_ASSET_NAME_LEN {
        issues.push(ThemeIssue::new(
            field,
            format!("must be a file name of 1 to {MAX_ASSET_NAME_LEN} characters"),
        ));
        return;
    }
    let plain = asset
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !plain || asset.starts_with('.') || asset.contains("..") {
        issues.push(ThemeIssue::new(
            field,
            "must be a plain file name in the theme's own folder (letters, digits, `.`, `_`, `-`)",
        ));
        return;
    }
    if asset_extension(asset).is_none() {
        issues.push(ThemeIssue::new(
            field,
            format!("must be one of: {}", ASSET_EXTENSIONS.join(", ")),
        ));
    }
}

/// The lowercased extension of an asset name, when it is one we can paint.
pub fn asset_extension(asset: &str) -> Option<&'static str> {
    let extension = asset.rsplit_once('.')?.1.to_ascii_lowercase();
    ASSET_EXTENSIONS
        .iter()
        .find(|known| **known == extension)
        .copied()
}

/// The same gate `css_vars` values pass, cap included — a color is a color
/// wherever it is written, and a texture layer has no more business carrying a
/// kilobyte of string than a token does.
fn check_color(field: &str, value: &str, issues: &mut Vec<ThemeIssue>) {
    if value.len() > MAX_VALUE_LEN {
        issues.push(ThemeIssue::new(
            field,
            format!("value must be at most {MAX_VALUE_LEN} characters"),
        ));
        return;
    }
    if let Err(error) = parse_color(value) {
        issues.push(ThemeIssue::new(field, error.to_string()));
    }
}

fn check_range(field: &str, value: f32, (min, max): Range, issues: &mut Vec<ThemeIssue>) {
    if !value.is_finite() || value < min || value > max {
        issues.push(ThemeIssue::new(
            field,
            format!("must be between {min} and {max}"),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bounds every number in a texture has to sit inside.
    ///
    fn halo() -> ThemeHalo {
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

    fn messages(chrome: &ThemeChrome) -> Vec<String> {
        validate(chrome).iter().map(ThemeIssue::describe).collect()
    }

    #[test]
    fn the_default_chrome_is_empty_and_valid() {
        let chrome = ThemeChrome::default();
        assert_eq!(chrome.chassis, ThemeChassis::Flat);
        assert_eq!(chrome.tabs, ThemeTabs::Underline);
        assert_eq!(chrome.texture, ThemeTexture::default());
        assert!(validate(&chrome).is_empty());
    }

    #[test]
    fn accepts_a_full_texture() {
        let chrome = ThemeChrome {
            chassis: ThemeChassis::Rail,
            tabs: ThemeTabs::Segmented,
            texture: ThemeTexture {
                base: Some("oklch(0.165 0.018 262)".into()),
                halos: vec![halo(), halo()],
                image: Some(ThemeImage {
                    asset: "paper.png".into(),
                    opacity: 0.2,
                    blend: ThemeBlend::Multiply,
                    fit: ThemeImageFit::Tile,
                    scale: 320.0,
                }),
                grain: Some(ThemeGrain {
                    color: "#9ea8c7".into(),
                    opacity: 0.36,
                    blend: ThemeBlend::Screen,
                    scale: 180.0,
                }),
                veil: true,
            },
        };
        assert_eq!(messages(&chrome), Vec::<String>::new());
    }

    #[test]
    fn rejects_an_unparseable_color() {
        let chrome = ThemeChrome {
            texture: ThemeTexture {
                base: Some("not-a-color".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(messages(&chrome)
            .iter()
            .any(|m| m.starts_with("chrome.texture.base")));
    }

    #[test]
    fn caps_a_chrome_color_at_the_same_length_a_token_value_gets() {
        // Without this the texture is the one place a theme can carry an
        // unbounded string: `css_vars` values are capped, and a color that long
        // is never a color anyway.
        let chrome = ThemeChrome {
            texture: ThemeTexture {
                base: Some("#".to_string() + &"0".repeat(MAX_VALUE_LEN)),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(messages(&chrome)
            .iter()
            .any(|m| m.contains("at most") && m.contains("characters")));
    }

    #[test]
    fn rejects_out_of_range_numbers_naming_the_offending_halo() {
        let chrome = ThemeChrome {
            texture: ThemeTexture {
                halos: vec![
                    halo(),
                    ThemeHalo {
                        opacity: 4.0,
                        ..halo()
                    },
                ],
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(
            messages(&chrome)
                .iter()
                .any(|m| m.starts_with("chrome.texture.halos[1].opacity")),
            "{:?}",
            messages(&chrome)
        );
    }

    #[test]
    fn rejects_more_halos_than_the_compositor_should_carry() {
        let chrome = ThemeChrome {
            texture: ThemeTexture {
                halos: vec![halo(); MAX_HALOS + 1],
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(messages(&chrome)
            .iter()
            .any(|m| m.contains("at most 8 halos")));
    }

    #[test]
    fn rejects_an_asset_that_could_name_a_file_outside_the_theme() {
        for asset in [
            "../../.ssh/id_rsa.png",
            "sub/dir.png",
            ".hidden.png",
            "https://example.com/x.png",
            "notes.txt",
            "",
        ] {
            let chrome = ThemeChrome {
                texture: ThemeTexture {
                    image: Some(ThemeImage {
                        asset: asset.into(),
                        opacity: 0.2,
                        blend: ThemeBlend::Normal,
                        fit: ThemeImageFit::Tile,
                        scale: 320.0,
                    }),
                    ..Default::default()
                },
                ..Default::default()
            };
            assert!(
                messages(&chrome)
                    .iter()
                    .any(|m| m.starts_with("chrome.texture.image.asset")),
                "{asset:?} must be rejected"
            );
        }
    }

    /// The failure mode this exists for: chrome is defaulted, so without
    /// `deny_unknown_fields` a misspelled key parses fine, contributes nothing,
    /// and leaves the theme quietly flat with no issue to read. Serde's message
    /// names the key *and* lists what was expected, which is the whole hint an
    /// agent editing the file needs.
    #[test]
    fn a_misspelled_key_is_reported_rather_than_dropped() {
        for (json, offending) in [
            (r#"{"chasis": "rail"}"#, "chasis"),
            (r#"{"texture": {"halo": []}}"#, "halo"),
            (
                r##"{"texture": {"grain": {"color": "#fff", "opacity": 0.3,
                    "blend": "screen", "scale": 180, "mode": "x"}}}"##,
                "mode",
            ),
        ] {
            let error = serde_json::from_str::<ThemeChrome>(json).expect_err("must be reported");
            let message = error.to_string();
            assert!(message.contains(offending), "{message}");
            assert!(message.contains("expected one of"), "{message}");
        }
    }

    #[test]
    fn recognizes_paintable_extensions_case_insensitively() {
        assert_eq!(asset_extension("paper.PNG"), Some("png"));
        assert_eq!(asset_extension("a.b.webp"), Some("webp"));
        assert_eq!(asset_extension("paper.txt"), None);
        assert_eq!(asset_extension("paper"), None);
    }
}
