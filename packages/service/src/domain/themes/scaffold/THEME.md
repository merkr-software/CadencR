# Editing this theme

This folder **is** a Cadencr theme. `theme.json` is the whole theme — there is no
build step and no code. Save the file and the running app repaints immediately.

## Check your work — run this after every edit

```sh
./check-theme          # macOS and Linux
check-theme.cmd        # Windows
```

**Do this before you say the theme is done.** A theme that fails validation is
*not applied*: the app keeps painting the last good one, so the window in front
of you looks fine while your change does nothing. The command is the app's own
gate, run on the spot — the same rules, the same wording, the same verdict you
would see in Settings → Appearance. It exits `0` when the theme is applicable
and non-zero when it is not, and prints one line per problem:

```
✗ My Theme — 2 problems. The app will not apply this theme.

  --block-tool-accent: contrast against `--block-tool-bg` is 2.76:1, below the 3.0:1 minimum
  --block-plan-accent: contrast against `--block-plan-bg` is 2.97:1, below the 3.0:1 minimum
```

Each problem names the key that caused it, so it points straight back into
`theme.json`. Fix, re-run, repeat until it says:

```
✓ My Theme — valid. Nothing is holding this theme back.
```

Cadencr maintains five files here: this one, `theme.schema.json`, `check-theme`,
and `AGENTS.md` / `CLAUDE.md`. None is tracked by git and none is part of the
theme; edits to them are overwritten. Everything else in the folder is yours.

## The one hard rule

Everything a theme can change is in this folder. **Never edit Cadencr's own
source** — its stylesheets, its TypeScript, its Rust — even if you can reach
them from here. People who install Cadencr have the app and not its source, so a
change there reaches nobody, and the app's stylesheets are shared, so a change
there rewrites every other theme at once.

The vocabulary below is closed on purpose. When something you were asked for
isn't in it, say so and stop: "that's app layout, not a theme setting" is a
correct and useful answer.

## The loop

1. Edit `theme.json`.
2. Cadencr re-reads it and re-validates it on save.
3. If it is valid, the app repaints — including this window.
4. If it is not, the theme is listed in the theme library with the problems
   spelled out, and **is not applied**. The last good look stays on screen.

Nothing in step 4 is visible from here, which is what `./check-theme` is for.

An invalid file is never destructive: nothing is lost, nothing is half-applied.
This folder is a git repository, so `git diff` shows what changed since the last
commit and `git checkout theme.json` puts back the last committed look.

## `theme.json`

| Key | Required | What it is |
|---|---|---|
| `$schema` | no | Points at `theme.schema.json` beside it. Leave it. |
| `label` | yes | The name in the theme library, 1–64 characters. Changing it also renames this project in the sidebar. |
| `appearance` | yes | `light` or `dark`. Drives `color-scheme`, the logo variant and editor fallbacks. Set it to what the theme actually *is* — a dark palette declared `light` gets light scrollbars and form controls. |
| `cssVars` | yes | Every design token, as a CSS color. |
| `xterm` | yes | The terminal palette. |
| `chrome` | no | The theme's shape rather than its palette. |

### `cssVars`

A closed set: every required token must be present and no unknown key is
allowed. `theme.schema.json` enumerates them, and the file you are editing
already has all of them. A handful more are *optional* — see "Chrome tokens"
below.

Values are CSS colors — `#rrggbb`, `rgb()`, `hsl()`, `oklch()`, with or without
alpha. A value may also be a single `var(--other-token)` reference to another
token in this theme, which is how the shipped themes avoid repeating themselves.

Two things get rejected:

- **`hsl(var(--x))`** and friends. These tokens hold whole color *values*, not
  HSL channel triples, so wrapping one in a color function produces nothing. It
  is the single most common way to break a theme.
- **Illegible pairs.** Body text against its surface must clear 4.5:1; buttons,
  hover fills and block headers must clear 3:1. The message names both tokens and
  the ratio you achieved.

Translucent surfaces are fine and are measured composited over `--background` —
a glass `--card` is judged as it is actually seen.

#### Chrome tokens

Four chrome tokens are optional. They color the shapes a theme opts into through
`chrome`, and each has a fallback derived from the palette, so leave them out
unless the derived one is wrong.

| Token | Paints | When it applies |
|---|---|---|
| `--tab-track-bg` | the recessed strip the tabs sit in | `chrome.tabs: "segmented"` |
| `--tab-track-border` | that strip's hairline | `chrome.tabs: "segmented"` |
| `--tab-active-bg` | the raised pill under the active tab | `chrome.tabs: "segmented"` |
| `--pane-border` | the page's edge against the sidebar, and pane hairlines | `chrome.chassis: "rail"` |

This is where tab colors live. If segmented tabs read as grey and you want them
carrying the theme's accent, set these three — not the app's stylesheet, which
would change every theme at once. Keep `--tab-active-bg` clearly lighter or
darker than `--tab-track-bg`, or the selected tab disappears into the track.

The two shadows the same chrome uses, `--tab-active-shadow` and `--page-shadow`,
are *not* theme tokens: they hold `box-shadow` values rather than colors, and a
theme's vocabulary is colors. They stay Cadencr's.

#### Sixth chart color

`--chart-6` is optional as well: the sixth categorical color, after
`--chart-1`…`--chart-5` (the marketplace tints skills with it). Without it
Cadencr mixes `--chart-2` and `--chart-4`. Set it to a hue the other five don't
use, at the same lightness and chroma.

### `chrome`

Optional. A theme that omits it is flat, with underlined tabs and nothing behind
the app — which is the right answer for most themes.

```json
"chrome": {
  "chassis": "rail",
  "tabs": "segmented",
  "texture": { "base": "#131416", "halos": [], "image": null, "grain": null, "veil": false }
}
```

| Key | Values | Effect |
|---|---|---|
| `chassis` | `flat`, `rail` | `rail` tucks the page into the sidebar as a raised card with a rounded top-left corner, sharing one continuous header band. `flat` sits full-bleed under its own header. Desktop only; narrow windows are always flat. |
| `tabs` | `underline`, `segmented` | Whether the active pane tab is a hairline indicator or a raised pill in a recessed track. |

`segmented` draws its track and pill from `--foreground` mixed into
`--background`, so it works on any palette without extra tokens. Set the
`--tab-*` tokens above to override that.

#### `texture`

What is painted behind the app, composited bottom to top: `base`, then `halos`,
then `image`, then `grain`, then `veil`. Every layer is optional; leaving them
all out costs nothing at all, because nothing is rendered.

**`base`** — a flat color, or `null`. Setting it also hands the page background
to the texture. That matters beyond looks: `backdrop-filter` glass only paints
when the backdrop root is opaque, so a theme with translucent surfaces over a
texture needs a `base`.

**`halos`** — an array of up to 8 drifting fields of blurred color. Each one is a
full-screen layer the compositor repaints, which is why the cap is low.

| Field | Range | Meaning |
|---|---|---|
| `color` | a CSS color | Usually carries its own alpha. |
| `size` | `1 … 400` | Diameter, in `vw`. |
| `x` | `-200 … 200` | Center, as a percentage of viewport width. Outside 0–100 anchors it off-screen. |
| `y` | `-200 … 200` | Center, as a percentage of viewport height. |
| `blur` | `0 … 400` | Blur radius in px. Large is the point — a halo should read as a field, not a circle. |
| `opacity` | `0 … 1` | |
| `drift` | `0 … 600` | Seconds for one drift cycle. `0` holds it still. |

**`image`** — a file from this folder. Drop it in beside `theme.json` and name
it; Cadencr reads and inlines it, so it travels with the theme.

| Field | Range | Meaning |
|---|---|---|
| `asset` | a file name | `paper.png` — never a path, never a URL. `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `avif`, up to 512 KiB. |
| `opacity` | `0 … 1` | |
| `blend` | see below | |
| `fit` | `tile`, `cover`, `contain` | |
| `scale` | `4 … 4096` | Tile size in px. Ignored unless `fit` is `tile`. |

**`grain`** — fine generated noise. The speckle is Cadencr's; the theme picks its
color and strength, so it tints with the palette instead of being baked in.

| Field | Range | Meaning |
|---|---|---|
| `color` | a CSS color | |
| `opacity` | `0 … 1` | Light themes want far less than dark ones. |
| `blend` | see below | `screen` on dark, `multiply` on light. |
| `scale` | `4 … 2048` | Tile size in px. Smaller reads as finer grain. |

**`veil`** — `true` washes the finished field back down with `--background` so
the UI above it stays legible. Worth turning on for anything lively.

`blend` is one of `normal`, `multiply`, `screen`, `overlay`, `soft-light`,
`hard-light`, `difference`, `luminosity`.

## When something is wrong

Every problem is reported against the key that caused it —
`chrome.texture.halos[1].opacity`, `--foreground`, `xterm.red`. Unknown keys
inside `chrome` are rejected rather than ignored, so a misspelling tells you
instead of quietly doing nothing.

Run `./check-theme` to read them. The same list appears on the theme's card in
Settings → Appearance, for the human.
