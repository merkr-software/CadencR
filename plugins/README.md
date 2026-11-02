# Official CadencR plugin sources

These plugins share the CadencR repository, **not its application build**. They
are not built-in providers/themes, bundled desktop resources or automatically
installed plugins. The desktop uses the same provider-neutral installation,
trust and conformance rules for official and third-party packages.

## Candidates

| Plugin                        | Source                                   | Candidate version |
| ----------------------------- | ---------------------------------------- | ----------------- |
| Pi provider                   | [`providers/pi`](providers/pi/README.md) | `0.4.1`           |
| Cursor provider               | [`providers/cursor`](providers/cursor/README.md) | `0.1.0` |
| Graphite, Ember, Fjord themes | [`themes`](themes/README.md)             | `0.1.0` each      |

Sources were imported from reviewed local repositories without their Git data,
dependencies, generated payloads, credentials or QA profiles. The original local
repositories remain untouched. Plugin-specific licenses are retained beside the
sources; Pi artwork provenance still requires review before publication.

## Separate commands

Run from the CadencR repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm run check:plugin:pi
pnpm run test:plugins
pnpm run build:plugin:pi
pnpm run package:plugin:pi --directory /absolute/new/pi-payload
pnpm run check:plugin:cursor
pnpm run test:plugin:cursor
pnpm run build:plugin:cursor
pnpm run package:plugin:cursor --directory /absolute/new/cursor-payload
```

The Cursor connector is a Rust crate and a Cargo workspace member, so the
workspace Rust checks (CI `rust` job, pre-commit Rust steps for its `.rs`,
`Cargo.toml` and test-fixture files) also cover it. Its `package.json` only
wraps those Cargo commands under the same plugin-scoped task names.

Pi is a workspace package only to share dependency management and security
policies. Its task names are explicitly plugin-scoped: generic Turbo application
tasks do not execute it. No application workspace dependency may reference it.
Generated `bin/` and `dist/` output is ignored, not desktop release content.

CI has a separate, unprivileged `plugins` job included in the required checks.
It runs fake-only Pi tests, builds the connector, checks supplemental theme
contrasts, then downloads the checksum-pinned released CLI for canonical theme
validation and deterministic packaging. It does not execute native Pi, send
model prompts, upload/sign/publish packages or change production trust pins.

## Independent releases

Future plugin tags use an explicit namespace, for example:

```text
plugins/provider-pi/v0.4.1
plugins/provider-cursor/v0.1.0
plugins/theme-graphite/v0.1.0
plugins/theme-ember/v0.1.0
plugins/theme-fjord/v0.1.0
```

Do not use `v0.4.1-pi`: the desktop release workflow matches `v*`. Plugin versions
are independent of the app version, and each immutable artifact must bind its
actual source commit/tag. No plugin tag, publication workflow or release is
created by this import. Namespaced tags must be URL-encoded in release-asset
metadata by the shared registry tooling.

The preparation workflow is read-only and does not grant publication authority. See
[`RELEASING.md`](RELEASING.md) for source/tag binding, sanitized artifact output,
qualification-only testing and the remaining protected-publication gates.

Publication remains gated on source/license review, supported-platform and
generic-host conformance, real GitHub lifecycle qualification, reviewed registry
cutover and protected signing authority. The registry remains a separate
repository; the marketplace stays hidden until a later activation decision.

## Source/package readiness

| Source | Machine-readable facts                                                                                                                               | Source-owned package inputs                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi     | [`providers/pi/readiness.json`](providers/pi/readiness.json): license/artwork digests, external runtimes, per-target native loopback evidence states | [`package-template.json`](providers/pi/package-template.json): fixed provider identity/assets, publisher `cadencr`, `min_app_version` `0.15.0`; archive URL/digest and publication `PENDING` |
| Cursor | [`providers/cursor/readiness.json`](providers/cursor/readiness.json): license/artwork digests, external Cursor CLI, per-target build/qualification states (none qualified) | [`package-template.json`](providers/cursor/package-template.json): provider id `cursor`, publisher `cadencr`, `min_app_version` `0.15.1`; archive `PENDING`. No `release-policy.json` entry yet: compiled payloads need a per-target build-and-record step (see its README) |
| Themes | [`themes/readiness.json`](themes/readiness.json): exact source/license/archive digests and visual-evidence boundary                                  | [`package-templates`](themes/package-templates/): three fixed identities and document version, publisher `cadencr`, `min_app_version` `0.15.0`; archive `PENDING`                            |

These documents distinguish source facts and historical qualification from
current-artifact approval. They neither bundle Node/Pi nor invent artwork rights,
signing authority or publication.
The shared canonical CLI remains responsible for schema/archive validation;
trusted release jobs consume reviewed Git data, not candidate build scripts.
