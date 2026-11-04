# Official CadencR plugin sources

These plugins share the CadencR repository, **not its application build**. They
are not bundled desktop resources or automatically installed plugins. The desktop
uses the same provider-neutral installation, trust and conformance rules for
first-party and third-party packages.

## Candidates

| Plugin                        | Source                                                                       | Candidate version |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------- |
| Cursor provider               | [`providers/cursor`](providers/cursor/README.md)                             | `0.1.0`           |
| Graphite, Ember, Fjord themes | [`themes`](themes/README.md)                                                 | `0.1.0` each      |
| TypeScript / JavaScript LSP   | [`lsp/typescript-language-server`](lsp/typescript-language-server/README.md) | `0.1.0`           |

The first-party Pi implementation has been retired in favor of
[edjubert's independent connector](https://github.com/edjubert/cadencr-plugin-provider-pi).
The registry handoff of `pi` is tracked in [the retirement record](../docs/PI_PROVIDER_HANDOFF.md).
Historical Pi releases and QA reports remain evidence for their original versions.

The TypeScript LSP source is a reviewed prepared snapshot of two locked official
npm distributions, including TypeScript and their notices. A single canonical
archive is tracked for trusted reconstruction of the three qualified targets.
Its minimum app version is `0.16.1`; publishing GitHub assets does not admit it to
the production marketplace.

## Separate commands

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm run test:plugins
pnpm run check:plugin:cursor
pnpm run test:plugin:cursor
pnpm run build:plugin:cursor
pnpm run package:plugin:cursor --directory /absolute/new/cursor-payload
```

The Cursor connector is a Rust crate and a Cargo workspace member. The workspace
Rust checks cover it, and its `package.json` wraps those commands with dedicated
plugin task names. Generic Turbo application tasks do not execute provider
plugins. No application workspace dependency may reference them. Generated
`bin/` and `dist/` output is ignored, not desktop release content.

CI has a separate unprivileged `plugins` job included in the required checks. It
checks supplemental theme contrasts, then downloads the checksum-pinned released
CLI for canonical theme validation and deterministic packaging. Cursor remains
covered by the workspace Rust job and its native qualification workflow.

## Independent releases

Plugin tags use an explicit namespace, for example:

```text
plugins/provider-cursor/v0.1.0
plugins/theme-graphite/v0.1.0
plugins/theme-ember/v0.1.0
plugins/theme-fjord/v0.1.0
```

Plugin versions are independent of the app version. Each immutable artifact binds
its actual source commit/tag. Namespaced tags must be URL-encoded in release-asset
metadata by the shared registry tooling. Desktop releases match `v*` tags.

See [`RELEASING.md`](RELEASING.md) for source/tag binding, sanitized artifact output
and protected publication. The registry remains a separate repository; source
changes here do not publish a signed catalog or transfer registry ownership.

## Source/package readiness

| Source | Machine-readable facts                                                                                                       | Source-owned package inputs                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor | [`readiness.json`](providers/cursor/readiness.json): source/license digests, external runtime and native qualification state | [`package-template.json`](providers/cursor/package-template.json): provider `cursor`, publisher `cadencr`, minimum app `0.16.0`; archive `PENDING`. No release-policy entry yet. |
| Themes | [`readiness.json`](themes/readiness.json): exact source/license/archive digests and visual evidence boundary                 | [`package-templates`](themes/package-templates/): three identities, document version, publisher `cadencr`, minimum app `0.15.0`                                                  |

The canonical CLI owns schema/archive validation. Trusted release jobs consume
reviewed Git data and never execute candidate build scripts.
