# Official Cadencr theme plugins

## Themes

| Theme    | Appearance | Palette                                                             | Candidate version |
| -------- | ---------- | ------------------------------------------------------------------- | ----------------- |
| Graphite | Dark       | Cool charcoal with blue actions                                     | `0.1.0`           |
| Ember    | Dark       | Warm charcoal with copper actions                                   | `0.1.0`           |
| Fjord    | Light      | Cool paper with deep-blue actions and dark editor/terminal surfaces | `0.1.0`           |

These are separately authored plugins, **not built-in or bundled themes**. Their
presence in this monorepo does not install or activate them. They are original
palettes without third-party visual assets, textures or executable content.
Source license: Apache-2.0; see [`LICENSE`](LICENSE).

## Provenance and candidate status

- Imported from the separate `cadencr-plugin-themes` source repository at commit
  `d2067f1`, preserving all three `theme.json` files and the license byte-for-byte.
- This README and the supplemental Python scripts were modified for monorepo
  paths and commands. The separate source repository remains untouched.
- Proposed initial version: `0.1.0` for each theme. The source review recorded a
  signed source-only baseline (`ba55310`); this import is not a signed release,
  registry acceptance, publication or marketplace activation.
- The source review recorded validation and deterministic packaging using the
  distributed Cadencr `v0.13.0` CLI, plus live current-source API/UI review of all
  three themes and persistence after an isolated restart. Those historical checks
  do not qualify this integration, a packaged Electron build or accessibility
  compliance. No new live-app QA is implied by importing these files.
- Compatibility metadata and registry publication remain pending. Marketplace
  activation is a separate future release decision.

## Source and distribution

```text
plugins/themes/
├── graphite/theme.json
├── ember/theme.json
├── fjord/theme.json
├── scripts/
├── README.md
└── LICENSE
```

Each distribution archive must contain **only `theme.json`**. Keep documentation,
license, previews, package/submission metadata and Git data outside distribution
staging. Never place credentials or private signing keys in this source tree.

## Validate and package

Run from the monorepo root with a reviewed Cadencr CLI. Building and running the
monorepo CLI uses the documented `pnpm rust --` wrapper, never bare `cargo`.
Canonical CLI validation/packaging is separate from the supplemental Python gate.
These commands do not publish or sign anything:

```sh
cadencr plugin validate plugins/themes/graphite --kind theme
cadencr plugin validate plugins/themes/ember --kind theme
cadencr plugin validate plugins/themes/fjord --kind theme

work=$(mktemp -d)
cadencr registry pack-theme --directory plugins/themes/graphite --output "$work/graphite-0.1.0.tar.gz"
cadencr registry pack-theme --directory plugins/themes/ember --output "$work/ember-0.1.0.tar.gz"
cadencr registry pack-theme --directory plugins/themes/fjord --output "$work/fjord-0.1.0.tar.gz"
```

Archive outputs must be new: the CLI refuses overwrites. Review exact bytes and
immutable source provenance before preparing registry submissions. The configured CI job independently fetches the pinned released CLI for canonical
theme checks; this describes the configuration, not a completed hosted run.
Passing CI is not a signed release.

## Recorded deterministic archive hashes

| Candidate | SHA-256                                                            |
| --------- | ------------------------------------------------------------------ |
| Graphite  | `feb4ba028cbb4abf9014284322d7920ad647e7c26318db586c8a50d9326ceb17` |
| Ember     | `1cdc169f0c6b037d6117496c9a7c14423b7a3a12147430c124f7ac09f174c05e` |
| Fjord     | `7b9b7cff609f794dc73234e91ddc683ef97b2448718fa413bf4b8b3c9e8f727a` |

These source-review hashes identify inert candidate archives, not public
availability or signed registry acceptance. Revalidate after any source change.

## Supplemental visual-state gate

Requires Python 3 only; no packages or private host paths. Run from the monorepo
root:

```sh
pnpm test:plugin:themes

# Equivalent direct checks without bytecode output:
PYTHONDONTWRITEBYTECODE=1 python3 plugins/themes/scripts/check_contrast.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s plugins/themes/scripts -p 'test_*.py'
```

Each theme receives 40 checks: 18 shared-contract tier pairs (8 at 4.5:1, 9 at
3:1, 1 at 1.5:1), 18 terminal-toolbar/warning/editor/bash state pairs at 4.5:1,
and 4 xterm text/selection/cursor pairs at 4.5:1. Ratios use unrounded sRGB
relative luminance. Both CSS and xterm terminal backgrounds must remain dark
(relative luminance below 0.03), including Fjord's light appearance.

This narrow gate accepts these asset-free, opaque six-digit hex originals only.
It rejects extra theme-folder files, symlinks, executable file bits, unexpected
document sections, duplicate JSON keys, missing checked colors and nonfinite
numbers. Seven mutation/reference tests cover every contrast pair and unsafe
inputs. The tier snapshot was reviewed against Cadencr `v0.13.0` and needs review
when the shared contract changes.

This is **not** the complete theme schema, a general asset validator, a WCAG audit
or packaging/signing logic. The reviewed CLI is authoritative for canonical
validation and packaging. Passing this gate does not certify rendered
hover/focus/disabled states: live visual review remains a separate prerequisite
before publication.
