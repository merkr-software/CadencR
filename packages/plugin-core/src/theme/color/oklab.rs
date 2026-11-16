//! Oklab / Oklch → linear-light sRGB.
//!
//! Cadencr's first-party themes author their Tailwind semantic tokens in
//! `oklch()`, so a theme duplicated from one is full of them — validation has to
//! understand the space, not just hex.
//!
//! Matrices are Björn Ottosson's published Oklab ↔ linear-sRGB constants.

use super::LinearRgba;

/// `oklab(L a b)` → linear sRGB. `l` is 0..1; `a`/`b` are roughly -0.4..0.4.
pub fn oklab_to_linear_srgb(l: f64, a: f64, b: f64, alpha: f64) -> LinearRgba {
    let l_ = l + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
    let m_ = l - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
    let s_ = l - 0.089_484_177_5 * a - 1.291_485_548_0 * b;

    let l3 = l_ * l_ * l_;
    let m3 = m_ * m_ * m_;
    let s3 = s_ * s_ * s_;

    LinearRgba::new(
        4.076_741_662_1 * l3 - 3.307_711_591_3 * m3 + 0.230_969_929_2 * s3,
        -1.268_438_004_6 * l3 + 2.609_757_401_1 * m3 - 0.341_319_396_5 * s3,
        -0.004_196_086_3 * l3 - 0.703_418_614_7 * m3 + 1.707_614_701_0 * s3,
        alpha,
    )
}

/// `oklch(L C H)` → linear sRGB. `hue` is in degrees.
pub fn oklch_to_linear_srgb(l: f64, c: f64, hue: f64, alpha: f64) -> LinearRgba {
    let radians = hue.to_radians();
    oklab_to_linear_srgb(l, c * radians.cos(), c * radians.sin(), alpha)
}

/// Gamma-decode an 0..1 sRGB component into linear light.
pub fn srgb_to_linear(channel: f64) -> f64 {
    if channel <= 0.040_45 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64, label: &str) {
        assert!(
            (actual - expected).abs() < 0.01,
            "{label}: {actual} != {expected}"
        );
    }

    #[test]
    fn oklch_white_round_trips_to_white() {
        let white = oklch_to_linear_srgb(1.0, 0.0, 0.0, 1.0);
        assert_close(white.r, 1.0, "r");
        assert_close(white.g, 1.0, "g");
        assert_close(white.b, 1.0, "b");
    }

    #[test]
    fn oklch_black_round_trips_to_black() {
        let black = oklch_to_linear_srgb(0.0, 0.0, 0.0, 1.0);
        assert_close(black.r, 0.0, "r");
        assert_close(black.g, 0.0, "g");
        assert_close(black.b, 0.0, "b");
    }

    #[test]
    fn oklch_matches_a_known_srgb_color() {
        // oklch(0.628 0.2577 29.23) is sRGB red (#ff0000).
        let red = oklch_to_linear_srgb(0.628, 0.2577, 29.23, 1.0);
        assert_close(red.r, 1.0, "r");
        assert_close(red.g, 0.0, "g");
        assert_close(red.b, 0.0, "b");
    }

    #[test]
    fn srgb_gamma_decode_hits_the_endpoints() {
        assert_close(srgb_to_linear(0.0), 0.0, "black");
        assert_close(srgb_to_linear(1.0), 1.0, "white");
        // Mid-gray decodes well below 0.5 — that non-linearity is the whole
        // reason luminance can't be computed on raw channel values.
        assert!(srgb_to_linear(0.5) < 0.25);
    }
}
