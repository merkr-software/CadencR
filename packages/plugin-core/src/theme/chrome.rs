//! The non-color half of a theme: how the app's chassis, tabs and background
//! *texture* are shaped.
//!
//! `css_vars` answers "what color is this"; chrome answers the three questions
//! that used to be answered by hardcoding a theme id in a stylesheet — whether
//! the page tucks into the sidebar rail, whether pane tabs are a segmented
//! control or an underline, and what (if anything) drifts behind the app. A
//! theme duplicated from CadencR Dark or Frost now carries those traits with it
//! instead of losing them at the door.
//!
//! Like the token set, this is a *closed* vocabulary: enums and bounded
//! numbers, never CSS text. The one open value is an image asset, which is a
//! file in the theme's own folder — read and inlined by the backend, never a
//! URL the theme gets to name.
//!
//! Every struct here denies unknown fields. Chrome is the one part of the
//! document that is *defaulted*, so serde's usual leniency would turn a
//! misspelled key into a silent no-op: the theme keeps loading, quietly flat,
//! and nothing anywhere says why. Whoever is editing the file — usually an agent
//! that has only the file to go on — has to be told. See `schema.rs` and the
//! `THEME.md` written beside it for the other half of that answer.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::color::parse_color;
use super::models::ThemeIssue;
use super::validate::MAX_VALUE_LEN;

mod validation;
pub use validation::*;

/// How the page meets the sidebar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeChassis {
    /// The page is a plain full-bleed surface under its own header.
    #[default]
    Flat,
    /// Sidebar and page header share one continuous rail; the content below
    /// tucks into it as a raised page with a rounded top-left corner.
    Rail,
}

impl ThemeChassis {
    /// Every value. The JSON Schema and `THEME.md` are both generated from these
    /// lists, so a new variant reaches whoever is editing a theme file without a
    /// second edit — extend the list when you add one.
    pub const ALL: &'static [Self] = &[Self::Flat, Self::Rail];
}

/// How the active pane tab is drawn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeTabs {
    /// A hairline indicator under the active tab.
    #[default]
    Underline,
    /// A recessed track holding a raised pill for the active tab.
    Segmented,
}

impl ThemeTabs {
    /// See [`ThemeChassis::ALL`].
    pub const ALL: &'static [Self] = &[Self::Underline, Self::Segmented];
}

/// How a texture layer composites over what is behind it. The CSS
/// `mix-blend-mode` values that are useful for a background wash.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeBlend {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    SoftLight,
    HardLight,
    Difference,
    Luminosity,
}

impl ThemeBlend {
    /// See [`ThemeChassis::ALL`].
    pub const ALL: &'static [Self] = &[
        Self::Normal,
        Self::Multiply,
        Self::Screen,
        Self::Overlay,
        Self::SoftLight,
        Self::HardLight,
        Self::Difference,
        Self::Luminosity,
    ];
}

/// How an image texture fills the window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeImageFit {
    /// Repeated at `scale` px — the right choice for a seamless noise or paper.
    #[default]
    Tile,
    /// Scaled to cover the window, cropping the overflow.
    Cover,
    /// Scaled to fit inside the window.
    Contain,
}

impl ThemeImageFit {
    /// See [`ThemeChassis::ALL`].
    pub const ALL: &'static [Self] = &[Self::Tile, Self::Cover, Self::Contain];
}

/// One drifting, heavily-blurred field of color.
///
/// Position is the halo's *center*, as a percentage of the viewport, so a
/// texture reads the same on any window shape. `size` is a diameter in `vw`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeHalo {
    pub color: String,
    /// Diameter, in `vw`.
    pub size: f32,
    /// Center, as a percentage of viewport width.
    pub x: f32,
    /// Center, as a percentage of viewport height.
    pub y: f32,
    /// Gaussian blur radius, in px.
    pub blur: f32,
    pub opacity: f32,
    /// Seconds for one drift cycle. `0` holds the halo still.
    pub drift: f32,
}

/// Fine noise laid over the field. The speckle itself is generated; a theme
/// picks its color, strength, tile size and how it composites.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeGrain {
    pub color: String,
    pub opacity: f32,
    pub blend: ThemeBlend,
    /// Tile size in px. Smaller reads as finer grain.
    pub scale: f32,
}

/// An image from the theme's own folder, laid over the field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeImage {
    /// File name inside the theme directory — `paper.png`, never a path or URL.
    pub asset: String,
    pub opacity: f32,
    pub blend: ThemeBlend,
    pub fit: ThemeImageFit,
    /// Tile size in px. Ignored unless `fit` is `tile`.
    pub scale: f32,
}

/// Everything painted behind the app, bottom to top: a flat base, drifting
/// halos, an image, grain, then an optional veil that dims the lot back down so
/// the UI on top stays readable.
///
/// The default is empty — no layers, nothing rendered, nothing to pay for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ThemeTexture {
    /// Flat color behind every layer. `None` leaves the page background alone.
    pub base: Option<String>,
    pub halos: Vec<ThemeHalo>,
    pub image: Option<ThemeImage>,
    pub grain: Option<ThemeGrain>,
    /// Wash the finished field with the page background, so surfaces above it
    /// keep their contrast. This is what keeps a lively texture legible.
    pub veil: bool,
}

/// The shape of a theme, as opposed to its palette.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ThemeChrome {
    pub chassis: ThemeChassis,
    pub tabs: ThemeTabs,
    pub texture: ThemeTexture,
}

/// Halos are cheap individually and ruinous in bulk — each one is a full-screen
/// blurred layer the compositor repaints.
pub const MAX_HALOS: usize = 8;
pub const MAX_ASSET_NAME_LEN: usize = 64;
/// Extensions that a browser will actually paint as a `background-image`.
pub const ASSET_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"];
