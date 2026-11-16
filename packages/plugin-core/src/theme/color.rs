//! CSS color parsing and WCAG contrast, for theme validation.
//!
//! A theme token is a *color value*, and the whole point of validating one is to
//! catch the class of bug we already shipped once: a token authored as
//! `hsl(var(--background))` — HSL channel triples, a shape Cadencr's tokens have
//! never used — parsed as nothing and silently killed every gradient that read
//! it. Rejecting a token that isn't a color, on the creator's machine, before it
//! can be applied, is what that bug costs.
//!
//! Colors resolve to **linear-light sRGB**, which is what WCAG relative
//! luminance is defined over, so no second conversion is needed downstream.

mod oklab;
mod parse;

pub use parse::parse_color;

/// A color in linear-light sRGB with straight (non-premultiplied) alpha.
/// Components are clamped to the sRGB gamut — an out-of-gamut `oklch()` is
/// still a usable color, it just paints as its clipped equivalent, exactly as
/// the browser renders it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinearRgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl LinearRgba {
    pub fn new(r: f64, g: f64, b: f64, a: f64) -> Self {
        Self {
            r: r.clamp(0.0, 1.0),
            g: g.clamp(0.0, 1.0),
            b: b.clamp(0.0, 1.0),
            a: a.clamp(0.0, 1.0),
        }
    }

    /// WCAG 2.x relative luminance.
    pub fn luminance(&self) -> f64 {
        0.2126 * self.r + 0.7152 * self.g + 0.0722 * self.b
    }

    /// Composite `self` over `backdrop` (source-over). Theme tokens are
    /// routinely translucent (`rgba(255, 255, 255, 0.05)` line highlights), and
    /// contrast is only meaningful against what the user actually sees.
    pub fn over(&self, backdrop: LinearRgba) -> LinearRgba {
        if self.a >= 1.0 {
            return *self;
        }
        let a = self.a + backdrop.a * (1.0 - self.a);
        if a <= 0.0 {
            return LinearRgba::new(0.0, 0.0, 0.0, 0.0);
        }
        let mix = |src: f64, dst: f64| (src * self.a + dst * backdrop.a * (1.0 - self.a)) / a;
        LinearRgba::new(
            mix(self.r, backdrop.r),
            mix(self.g, backdrop.g),
            mix(self.b, backdrop.b),
            a,
        )
    }
}

/// WCAG contrast ratio between a foreground and a background, compositing the
/// foreground over the background first so translucency is accounted for.
pub fn contrast_ratio(foreground: LinearRgba, background: LinearRgba) -> f64 {
    let fg = foreground.over(background).luminance();
    let bg = background.luminance();
    let (lighter, darker) = if fg >= bg { (fg, bg) } else { (bg, fg) };
    (lighter + 0.05) / (darker + 0.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(value: &str) -> LinearRgba {
        parse_color(value).expect("parses")
    }

    #[test]
    fn black_on_white_is_the_maximum_ratio() {
        let ratio = contrast_ratio(rgb("#000000"), rgb("#ffffff"));
        assert!((ratio - 21.0).abs() < 0.01, "{ratio}");
    }

    #[test]
    fn identical_colors_have_no_contrast() {
        let ratio = contrast_ratio(rgb("#3b82f6"), rgb("#3b82f6"));
        assert!((ratio - 1.0).abs() < 0.001, "{ratio}");
    }

    #[test]
    fn contrast_is_symmetric() {
        let a = contrast_ratio(rgb("#767676"), rgb("#ffffff"));
        let b = contrast_ratio(rgb("#ffffff"), rgb("#767676"));
        assert!((a - b).abs() < 0.001);
    }

    #[test]
    fn known_wcag_reference_pair() {
        // #767676 on white is the canonical "just passes 4.5:1" gray.
        let ratio = contrast_ratio(rgb("#767676"), rgb("#ffffff"));
        assert!((4.5..4.6).contains(&ratio), "{ratio}");
    }

    #[test]
    fn translucent_foreground_composites_before_measuring() {
        // Pure white at 10% over black is a dark gray, nowhere near the 21:1 an
        // opaque white would score.
        let ratio = contrast_ratio(rgb("rgba(255, 255, 255, 0.1)"), rgb("#000000"));
        assert!(ratio < 4.0, "{ratio}");
        assert!(ratio > contrast_ratio(rgb("#111111"), rgb("#000000")));
    }

    #[test]
    fn dracula_foreground_on_background_passes_aa() {
        let ratio = contrast_ratio(
            rgb("oklch(0.977 0.008 106.793)"),
            rgb("oklch(0.22 0.022 277.497)"),
        );
        assert!(ratio > 4.5, "{ratio}");
    }
}
