# @cadencr/brand

The single source of truth for Cadencr's brand: the Index Dots mark's geometry,
the Emerald Reserve palette, and every icon and social image generated from
them. Change the logo here and one command updates the whole repo.

Before this package existed, the mark lived in two generator scripts that each
kept their own copy of the palette, reached across package boundaries by
relative path, were wired to no npm script, and had nothing checking that the
committed assets still matched. Two assets had already drifted off-brand.

## Changing the brand

```bash
# edit src/tokens.mjs, src/geometry.mjs, or src/svg/*
pnpm brand:install     # rewrite every generated asset in every package
pnpm brand:check       # fail if a committed asset has drifted (runs on commit)
```

`brand:install` accepts target names to narrow the work:
`node scripts/install-assets.mjs desktop`.

## Layout

| Path                        | Purpose                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `src/tokens.mjs`            | Colors and the mark's two cuts                                              |
| `src/geometry.mjs`          | `ringDots()` — the twelve-dot ring                                          |
| `src/svg/mark.mjs`          | The mark in every shape: in-app, tile, app icon, adaptive favicon           |
| `src/svg/social.mjs`        | The 1280×640 social card                                                    |
| `src/svg/wordmark.mjs`      | Outlined Figtree glyph paths for the social card's text                     |
| `src/encode/`               | `sharp` rasterizing plus the ICO and ICNS container writers/readers         |
| `src/targets/`              | One manifest per consumer — what gets written where                         |
| `src/assets.mjs`            | Manifest entry → bytes, and the drift comparison for each kind              |
| `scripts/readme-assets.mjs` | README compositions from versioned product captures and the official lockup |

`src/index.mjs` is the public API that application code imports
(`import { ringDots, STANDARD_CUT } from "@cadencr/brand"`). It deliberately
pulls in no `sharp`, so it is safe in browser bundles and the Electron main
process.

## README product assets

The README uses three compositions captured from v0.14.1 with example
conversations in an isolated workspace. Their recipe imports the same mark, outlined Figtree
wordmark, and palette as the other brand assets. It adds framing without
redrawing or fabricating product UI.

```bash
pnpm --filter @cadencr/brand readme:install
pnpm --filter @cadencr/brand readme:check
```

When refreshing the screenshots, update the versioned source directory and
recipes in `scripts/readme-assets.mjs`, regenerate, and update the README's
captions and the [asset inventory](../../.github/assets/readme/README.md).
The package's `test` command checks these compositions for drift too, using
decoded pixels rather than encoded PNG bytes.

## Why assets are committed

Generated files are written into each consumer at the paths those consumers
already used, and stay git-tracked. electron-builder resolves `icon: icons/icon`
off disk, Astro serves `public/` verbatim, and `index.html` links favicons by
path — none of them can wait on a generator. Committing keeps the build simple
and makes brand changes visible in review.

`brand:check` closes the obvious hole: it runs from this package's `test`
script, so a stale asset fails pre-commit and CI.

That task is marked `"cache": false` in the root `turbo.json`, and it has to
stay that way. Turbo keys a task on its own package's files, but `--check`
reads assets in _other_ packages — so with caching on, editing a committed icon
by hand replays a cached pass and reports "assets up to date" without ever
looking at the file.

## Why `--check` compares pixels, not bytes

PNG output is stable across repeated runs on one machine, but not across a
`sharp`/libvips/zlib-ng bump or between macOS and Linux prebuilds — a byte check
would false-fail the first time CI ran. librsvg's _rasterization_ of a given SVG
at a given size is deterministic, so `--check` decodes both sides to raw pixels
and compares those. ICO and ICNS files are parsed and compared entry by entry,
which also round-trip-tests the container writers. SVG assets are text we
author, so they stay byte-exact.

## Regenerating the wordmark outlines

`src/svg/wordmark.mjs` holds the social card's two fixed strings as outlined
paths. This is not premature cleverness: librsvg **silently ignores
`@font-face` with a base64 `src`**, so `<text>` renders in whatever font the
host machine happens to have — verified by rendering the wordmark three ways
(`sans-serif`, `Figtree`, and `Figtree` with an inlined base64 face) and getting
byte-identical output all three times. That is why the previous `og-image.png`
was set in a fallback grotesk rather than Figtree.

To regenerate (needs `fontkit` and `wawoff2`; install them **outside** this repo
so they stay out of the lockfile):

1. Decompress the variable font — `fontkit`'s `getVariation()` returns an
   instance with no decoded tables when given a woff2 directly:
   ```js
   const ttf = await wawoff2.decompress(
     fs.readFileSync(
       "node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
     ),
   );
   ```
2. `fontkit.openSync(ttf)`, then `getVariation({ wght: 800 })` for the wordmark
   and `{ wght: 500 }` for the tagline.
3. Lay out each string, translate each glyph by its advance (plus `0.05em`
   tracking on the wordmark, per DESIGN.md), and `.scale(s, -s)` to flip from
   font units (y-up) to SVG (y-down), where `s = 100 / capHeight`.
4. Write the resulting `{ advance, d }` pairs into `WORDMARK` and `TAGLINE`.

The paths use a baseline-left origin with cap height normalized to 100;
`outlinedText()` scales that to whatever cap height a composition asks for.
