//! Parse the CSS color syntaxes Cadencr themes are authored in.
//!
//! Supported: hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`, `oklab()`,
//! `transparent`, and the sixteen basic color keywords. Anything else — a
//! keyword we don't know, a `var()` that didn't resolve, a length, a gradient —
//! is an error rather than a silent fallback, because "silently nothing" is the
//! exact failure mode theme validation exists to prevent.

use std::fmt;

use super::oklab::{oklab_to_linear_srgb, oklch_to_linear_srgb, srgb_to_linear};
use super::LinearRgba;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorParseError(String);

impl fmt::Display for ColorParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn err(message: impl Into<String>) -> ColorParseError {
    ColorParseError(message.into())
}

/// The sixteen basic CSS color keywords, as sRGB bytes.
const NAMED: &[(&str, [u8; 3])] = &[
    ("black", [0, 0, 0]),
    ("silver", [192, 192, 192]),
    ("gray", [128, 128, 128]),
    ("grey", [128, 128, 128]),
    ("white", [255, 255, 255]),
    ("maroon", [128, 0, 0]),
    ("red", [255, 0, 0]),
    ("purple", [128, 0, 128]),
    ("fuchsia", [255, 0, 255]),
    ("green", [0, 128, 0]),
    ("lime", [0, 255, 0]),
    ("olive", [128, 128, 0]),
    ("yellow", [255, 255, 0]),
    ("navy", [0, 0, 128]),
    ("blue", [0, 0, 255]),
    ("teal", [0, 128, 128]),
    ("aqua", [0, 255, 255]),
];

pub fn parse_color(value: &str) -> Result<LinearRgba, ColorParseError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(err("value is empty"));
    }
    let lowered = value.to_ascii_lowercase();

    if lowered == "transparent" {
        return Ok(LinearRgba::new(0.0, 0.0, 0.0, 0.0));
    }
    if let Some(&(_, [r, g, b])) = NAMED.iter().find(|(name, _)| *name == lowered) {
        return Ok(from_srgb_bytes(r, g, b, 1.0));
    }
    if let Some(hex) = lowered.strip_prefix('#') {
        return parse_hex(hex);
    }
    if let Some((name, inner)) = split_function(&lowered) {
        return match name {
            "rgb" | "rgba" => parse_rgb(inner),
            "hsl" | "hsla" => parse_hsl(inner),
            "oklch" => parse_oklch(inner),
            "oklab" => parse_oklab(inner),
            other => Err(err(format!(
                "`{other}()` is not a supported color function (use hex, rgb, hsl, oklch or oklab)"
            ))),
        };
    }
    Err(err(format!("`{value}` is not a color")))
}

fn from_srgb_bytes(r: u8, g: u8, b: u8, alpha: f64) -> LinearRgba {
    from_srgb_unit(
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
        alpha,
    )
}

fn from_srgb_unit(r: f64, g: f64, b: f64, alpha: f64) -> LinearRgba {
    LinearRgba::new(
        srgb_to_linear(r.clamp(0.0, 1.0)),
        srgb_to_linear(g.clamp(0.0, 1.0)),
        srgb_to_linear(b.clamp(0.0, 1.0)),
        alpha,
    )
}

fn parse_hex(hex: &str) -> Result<LinearRgba, ColorParseError> {
    let nibble = |c: char| c.to_digit(16).map(|d| d as u8);
    let digits: Option<Vec<u8>> = hex.chars().map(nibble).collect();
    let digits = digits.ok_or_else(|| err(format!("`#{hex}` is not a valid hex color")))?;
    let (r, g, b, a) = match digits.as_slice() {
        [r, g, b] => (r * 17, g * 17, b * 17, 255),
        [r, g, b, a] => (r * 17, g * 17, b * 17, a * 17),
        [r1, r0, g1, g0, b1, b0] => (r1 * 16 + r0, g1 * 16 + g0, b1 * 16 + b0, 255),
        [r1, r0, g1, g0, b1, b0, a1, a0] => {
            (r1 * 16 + r0, g1 * 16 + g0, b1 * 16 + b0, a1 * 16 + a0)
        }
        _ => return Err(err(format!("`#{hex}` must have 3, 4, 6 or 8 hex digits"))),
    };
    Ok(from_srgb_bytes(r, g, b, f64::from(a) / 255.0))
}

/// Split `name(inner)` into its parts. Returns `None` when `value` isn't a
/// well-formed function call.
fn split_function(value: &str) -> Option<(&str, &str)> {
    let open = value.find('(')?;
    let inner = value.strip_suffix(')')?.get(open + 1..)?;
    let name = value[..open].trim();
    if name.is_empty() {
        return None;
    }
    Some((name, inner))
}

/// Split a function's arguments into components plus an optional alpha,
/// accepting both the legacy comma syntax (`rgba(r, g, b, a)`) and the modern
/// space + slash syntax (`oklch(l c h / a)`).
fn split_args(inner: &str) -> (Vec<&str>, Option<&str>) {
    let (body, alpha) = match inner.split_once('/') {
        Some((body, alpha)) => (body, Some(alpha.trim())),
        None => (inner, None),
    };
    let mut parts: Vec<&str> = if body.contains(',') {
        body.split(',').map(str::trim).collect()
    } else {
        body.split_whitespace().collect()
    };
    match alpha {
        Some(alpha) => (parts, Some(alpha)),
        // Legacy syntax carries alpha as a fourth comma-separated argument.
        None if parts.len() == 4 => {
            let alpha = parts.pop();
            (parts, alpha)
        }
        None => (parts, None),
    }
}

/// A number, a percentage of `scale`, or the `none` keyword (which CSS defines
/// as "missing", and which behaves as zero everywhere we use it).
fn number(raw: &str, scale: f64) -> Result<f64, ColorParseError> {
    let raw = raw.trim();
    if raw == "none" {
        return Ok(0.0);
    }
    if let Some(percent) = raw.strip_suffix('%') {
        let value: f64 = percent
            .trim()
            .parse()
            .map_err(|_| err(format!("`{raw}` is not a number")))?;
        return Ok(value / 100.0 * scale);
    }
    raw.parse()
        .map_err(|_| err(format!("`{raw}` is not a number")))
}

fn alpha_of(raw: Option<&str>) -> Result<f64, ColorParseError> {
    match raw {
        Some(raw) => Ok(number(raw, 1.0)?.clamp(0.0, 1.0)),
        None => Ok(1.0),
    }
}

/// An angle in degrees. Bare numbers are degrees; `deg`, `turn`, `rad` and
/// `grad` are all legal in CSS color functions.
fn angle(raw: &str) -> Result<f64, ColorParseError> {
    let raw = raw.trim();
    for (suffix, per_unit) in [
        ("deg", 1.0),
        ("turn", 360.0),
        ("rad", 57.295_779_513),
        ("grad", 0.9),
    ] {
        if let Some(value) = raw.strip_suffix(suffix) {
            return Ok(number(value, 1.0)? * per_unit);
        }
    }
    number(raw, 360.0)
}

fn expect_three<'a>(
    args: &'a [&'a str],
    function: &str,
) -> Result<(&'a str, &'a str, &'a str), ColorParseError> {
    match args {
        [a, b, c] => Ok((a, b, c)),
        _ => Err(err(format!(
            "`{function}()` takes 3 components, got {}",
            args.len()
        ))),
    }
}

fn parse_rgb(inner: &str) -> Result<LinearRgba, ColorParseError> {
    let (args, alpha) = split_args(inner);
    let (r, g, b) = expect_three(&args, "rgb")?;
    Ok(from_srgb_unit(
        number(r, 255.0)? / 255.0,
        number(g, 255.0)? / 255.0,
        number(b, 255.0)? / 255.0,
        alpha_of(alpha)?,
    ))
}

fn parse_hsl(inner: &str) -> Result<LinearRgba, ColorParseError> {
    let (args, alpha) = split_args(inner);
    let (h, s, l) = expect_three(&args, "hsl")?;
    let hue = angle(h)?.rem_euclid(360.0);
    let saturation = number(s, 1.0)?.clamp(0.0, 1.0);
    let lightness = number(l, 1.0)?.clamp(0.0, 1.0);

    let c = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let x = c * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let m = lightness - c / 2.0;
    let (r, g, b) = match hue as u32 / 60 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    Ok(from_srgb_unit(r + m, g + m, b + m, alpha_of(alpha)?))
}

fn parse_oklch(inner: &str) -> Result<LinearRgba, ColorParseError> {
    let (args, alpha) = split_args(inner);
    let (l, c, h) = expect_three(&args, "oklch")?;
    Ok(oklch_to_linear_srgb(
        number(l, 1.0)?,
        number(c, 0.4)?,
        angle(h)?,
        alpha_of(alpha)?,
    ))
}

fn parse_oklab(inner: &str) -> Result<LinearRgba, ColorParseError> {
    let (args, alpha) = split_args(inner);
    let (l, a, b) = expect_three(&args, "oklab")?;
    Ok(oklab_to_linear_srgb(
        number(l, 1.0)?,
        number(a, 0.4)?,
        number(b, 0.4)?,
        alpha_of(alpha)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip back to 0..255 sRGB bytes so expectations read naturally.
    fn bytes(value: &str) -> (u8, u8, u8, f64) {
        let color = parse_color(value).unwrap_or_else(|e| panic!("{value}: {e}"));
        let encode = |linear: f64| {
            let srgb = if linear <= 0.003_130_8 {
                linear * 12.92
            } else {
                1.055 * linear.powf(1.0 / 2.4) - 0.055
            };
            (srgb * 255.0).round() as u8
        };
        (encode(color.r), encode(color.g), encode(color.b), color.a)
    }

    #[test]
    fn parses_every_hex_length() {
        assert_eq!(bytes("#f00"), (255, 0, 0, 1.0));
        assert_eq!(bytes("#ff0000"), (255, 0, 0, 1.0));
        assert_eq!(bytes("#FF0000"), (255, 0, 0, 1.0));
        let (r, g, b, alpha) = bytes("#ff000080");
        assert_eq!((r, g, b), (255, 0, 0));
        assert!((alpha - 0.502).abs() < 0.01, "{alpha}");
        // The 4-digit form expands each nibble, so `8` is the same 0x88 alpha.
        assert!((bytes("#f008").3 - 0.533).abs() < 0.01);
    }

    #[test]
    fn parses_legacy_and_modern_rgb() {
        assert_eq!(bytes("rgb(255, 0, 0)"), (255, 0, 0, 1.0));
        assert_eq!(bytes("rgb(255 0 0)"), (255, 0, 0, 1.0));
        assert_eq!(bytes("rgba(139, 233, 253, 0.18)").3, 0.18);
        assert_eq!(bytes("rgb(255 0 0 / 50%)").3, 0.5);
        assert_eq!(bytes("rgb(100%, 0%, 0%)"), (255, 0, 0, 1.0));
    }

    #[test]
    fn parses_hsl() {
        assert_eq!(bytes("hsl(0, 100%, 50%)"), (255, 0, 0, 1.0));
        assert_eq!(bytes("hsl(120 100% 50%)"), (0, 255, 0, 1.0));
        assert_eq!(bytes("hsl(240deg 100% 50%)"), (0, 0, 255, 1.0));
        assert_eq!(bytes("hsl(0.5turn 100% 50%)"), (0, 255, 255, 1.0));
        assert_eq!(bytes("hsla(0, 0%, 0%, 0.25)").3, 0.25);
    }

    #[test]
    fn parses_oklch_and_oklab() {
        // Both spellings of sRGB red.
        assert_eq!(bytes("oklch(0.6279 0.2577 29.23)"), (255, 0, 0, 1.0));
        assert_eq!(bytes("oklch(62.79% 0.2577 29.23)"), (255, 0, 0, 1.0));
        assert_eq!(bytes("oklab(0.6279 0.2249 0.1258)"), (255, 0, 0, 1.0));
        assert_eq!(bytes("oklch(0.6279 0.2577 29.23 / 0.5)").3, 0.5);
    }

    #[test]
    fn parses_keywords() {
        assert_eq!(bytes("white"), (255, 255, 255, 1.0));
        assert_eq!(bytes("transparent").3, 0.0);
    }

    #[test]
    fn rejects_the_hsl_var_channel_bug() {
        // The shipped bug this validator exists for: tokens are color *values*,
        // never HSL channel triples, so `hsl(var(--background))` must fail loudly.
        let error = parse_color("hsl(var(--background))").expect_err("must reject");
        assert!(error.to_string().contains("3 components"), "{error}");
    }

    #[test]
    fn rejects_non_colors() {
        for value in [
            "",
            "0.625rem",
            "var(--code-fg)",
            "linear-gradient(red, blue)",
            "#12345",
            "#zzzzzz",
            "papayawhip",
            "rgb(1, 2)",
        ] {
            assert!(parse_color(value).is_err(), "should reject `{value}`");
        }
    }

    #[test]
    fn out_of_gamut_oklch_clips_instead_of_failing() {
        let color = parse_color("oklch(0.9 0.4 150)").expect("clips into gamut");
        assert!((0.0..=1.0).contains(&color.r));
        assert!((0.0..=1.0).contains(&color.g));
    }
}
