use super::*;

pub(super) fn defs() -> Value {
    json!({
        "chrome": {
            "type": "object",
            "description": "The theme's shape rather than its palette. Optional \
                            — a theme that omits it is flat, with underlined \
                            tabs and nothing behind the app.",
            "properties": {
                "chassis": {
                    "enum": names(ThemeChassis::ALL),
                    "default": "flat",
                    "description": "`rail` tucks the page into the sidebar as a \
                                    raised card with a rounded top-left corner, \
                                    sharing one continuous header band. `flat` \
                                    sits full-bleed under its own header. \
                                    Desktop only — narrow windows are always flat.",
                },
                "tabs": {
                    "enum": names(ThemeTabs::ALL),
                    "default": "underline",
                    "description": "How the active pane tab is drawn: a hairline \
                                    indicator, or a raised pill in a recessed track.",
                },
                "texture": { "$ref": "#/$defs/texture" },
            },
            "additionalProperties": false,
        },
        "texture": texture(),
        "halo": halo(),
        "grain": grain(),
        "image": image(),
    })
}

fn texture() -> Value {
    json!({
        "type": "object",
        "description": "What is painted behind the app, bottom to top: base, \
                        halos, image, grain, veil. Every layer is optional.",
        "properties": {
            "base": {
                "type": ["string", "null"],
                "description": format!(
                    "{COLOR} A flat color behind every other layer. Setting it \
                     also hands the page background to the texture, which is \
                     what lets `backdrop-filter` glass paint at all — a texture \
                     with translucent surfaces above it wants a base.",
                ),
            },
            "halos": {
                "type": "array",
                "maxItems": MAX_HALOS,
                "items": { "$ref": "#/$defs/halo" },
                "description": format!(
                    "Drifting fields of blurred color. At most {MAX_HALOS} — \
                     each one is a full-screen layer the compositor repaints.",
                ),
            },
            "image": {
                "oneOf": [{ "$ref": "#/$defs/image" }, { "type": "null" }],
            },
            "grain": {
                "oneOf": [{ "$ref": "#/$defs/grain" }, { "type": "null" }],
            },
            "veil": {
                "type": "boolean",
                "default": false,
                "description": "Wash the finished field back down with the page \
                                background so the UI above it stays legible. \
                                Worth turning on for anything lively.",
            },
        },
        "additionalProperties": false,
    })
}

fn halo() -> Value {
    json!({
        "type": "object",
        "required": ["color", "size", "x", "y", "blur", "opacity", "drift"],
        "properties": {
            "color": { "type": "string", "description": COLOR },
            "size": number(HALO_SIZE, "Diameter, in `vw`."),
            "x": number(HALO_OFFSET, "Center, as a percentage of viewport width. \
                                      Values outside 0–100 anchor a halo off-screen."),
            "y": number(HALO_OFFSET, "Center, as a percentage of viewport height."),
            "blur": number(HALO_BLUR, "Blur radius, in px. Large is the point — \
                                       a halo should read as a field, not a circle."),
            "opacity": number(OPACITY, "0–1."),
            "drift": number(HALO_DRIFT, "Seconds for one drift cycle. `0` holds \
                                         the halo still."),
        },
        "additionalProperties": false,
    })
}

fn grain() -> Value {
    json!({
        "type": "object",
        "description": "Fine generated noise over the field. The speckle is \
                        Cadencr's; the theme picks its color and strength.",
        "required": ["color", "opacity", "blend", "scale"],
        "properties": {
            "color": { "type": "string", "description": COLOR },
            "opacity": number(OPACITY, "0–1. Light themes want far less than dark ones."),
            "blend": blend(),
            "scale": number(GRAIN_SCALE, "Tile size in px. Smaller reads as finer grain."),
        },
        "additionalProperties": false,
    })
}

fn image() -> Value {
    json!({
        "type": "object",
        "description": "An image from this theme's own folder. Drop the file in \
                        beside `theme.json` and name it here — Cadencr reads it \
                        and inlines it, so it travels with the theme.",
        "required": ["asset", "opacity", "blend", "fit", "scale"],
        "properties": {
            "asset": {
                "type": "string",
                "maxLength": MAX_ASSET_NAME_LEN,
                "pattern": asset_pattern(),
                "description": format!(
                    "A plain file name in this folder — `paper.png`, never a \
                     path or a URL. One of: {}.",
                    ASSET_EXTENSIONS.join(", "),
                ),
            },
            "opacity": number(OPACITY, "0–1."),
            "blend": blend(),
            "fit": {
                "enum": names(ThemeImageFit::ALL),
                "description": "`tile` repeats the image at `scale`; `cover` and \
                                `contain` size one copy to the window.",
            },
            "scale": number(IMAGE_SCALE, "Tile size in px. Ignored unless `fit` is `tile`."),
        },
        "additionalProperties": false,
    })
}

fn blend() -> Value {
    json!({
        "enum": names(ThemeBlend::ALL),
        "description": "How this layer composites over what is behind it — the \
                        CSS `mix-blend-mode` values worth using on a background.",
    })
}

fn number((min, max): Range, description: &str) -> Value {
    json!({
        "type": "number",
        "minimum": min,
        "maximum": max,
        "description": description,
    })
}

/// A file name in this folder with a paintable extension, matching what
/// `chrome::validate` accepts: no leading dot, no `..`, no separator, and the
/// extension in any case.
pub(super) fn asset_pattern() -> String {
    let extensions: Vec<String> = ASSET_EXTENSIONS
        .iter()
        .map(|extension| {
            extension
                .chars()
                .map(|c| format!("[{}{}]", c, c.to_ascii_uppercase()))
                .collect()
        })
        .collect();
    format!(
        r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.({})$",
        extensions.join("|")
    )
}
