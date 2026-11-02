# Multi-export plugins

A **plugin** is one marketplace package that contributes several kinds at
once — for example a theme, a provider (agent CLI connector) and a custom tab,
in any combination. It is released, signed, listed and updated as one unit,
while each member keeps its own installer, receipts, consent and revocation.

Normative code: `packages/registry-core/src/plugin_package.rs` (contract and
flattening), `marketplace_plan.rs` (mirroring), `submission/schema_two.rs`
(source binding). Author workflow: `tooling/marketplace-registry/AUTHORING.md`
("Multi-export plugins").

## Catalog entry

A schema-2 catalog entry of kind `plugin`:

```json
{
  "kind": "plugin",
  "package": {
    "plugin": {
      "id": "aurora",
      "name": "Aurora",
      "description": "Theme, agent and dashboard tab",
      "version": "1.0.0",
      "repository": "https://github.com/acme/aurora",
      "license": "MIT"
    },
    "host": {
      "publisher": "acme",
      "compatibility": { "min_app_version": "0.16.0" }
    },
    "contributes": [
      {
        "kind": "provider",
        "package": {
          "agent": { "id": "aurora-agent", "…": "…" },
          "host": { "…": "…" }
        }
      },
      {
        "kind": "tab",
        "package": {
          "tab": { "id": "aurora-tab", "…": "…" },
          "host": { "…": "…" }
        }
      },
      {
        "kind": "theme",
        "package": {
          "theme": { "id": "aurora-theme", "…": "…" },
          "host": { "…": "…" }
        }
      }
    ]
  }
}
```

- `contributes` holds 1–6 **complete standalone entries**, validated by their
  own kind's rules, sorted by kind then id. Plugins never nest.
- Every member carries the plugin's `version`, `repository`, `host.publisher`
  and `host.compatibility`: one release ships and updates them together.
- The plugin id and every member id share the catalog's single id namespace
  (`id@version` uniqueness, normalized-id collisions, immutable ownership), so a
  member id can never be reused by another package or kind.
- The plugin's `host` holds only `publisher` and `compatibility`: a plugin has
  no archive of its own, so it declares no assets. Members keep theirs (a
  provider member still declares its icon, readme and license).

## Consumption

Apps never install "a plugin": `cadencr_registry_core::catalog_members`
flattens a catalog into the single-kind entries each installer already
resolves. The service uses it for theme and tab resolution, recommendations,
tab review (platform, protocol, blocklist) and receipt retention, and for the
provider view. Installing a plugin is installing each member through its
existing endpoint, which the desktop orchestrates. Revocation stays per member
on the theme, tab and provider blocklists. Blocking a plugin means listing each
member.

**Forward compatibility.** A consumed catalog (`Rules::Consume`) now skips an
entry, or a plugin member, of a kind this build does not know, instead of
rejecting the whole catalog. Publication (`Rules::Publish`) still refuses it.
Before this change, any new kind would have broken every released app's
marketplace.

## Publication

A plugin is one schema-2 submission. Every member archive (theme and tab web
archives, tab backend archives, provider binaries) must be an asset of the
submission's source release tag. The registry mirrors it into **one** release,
`plugin-<id>-v<version>`, with member-prefixed targets and assets:

| Member target     | Plan target                   | Mirrored asset                             |
| ----------------- | ----------------------------- | ------------------------------------------ |
| theme web archive | `theme:<id>:theme`            | `theme-<id>-theme.tar.gz`                  |
| tab web archive   | `tab:<id>:tab`                | `tab-<id>-tab.tar.gz`                      |
| tab backend       | `tab:<id>:backend-<platform>` | `tab-<id>-backend-<platform>-<sha>.tar.gz` |
| provider binary   | `provider:<id>:<platform>`    | `provider-<id>-<platform>-<sha><suffix>`   |

The publisher verifies each staged and public archive with its member kind's
rules. A plugin plan may carry up to `6 × 6` targets.

## Rollout and open items

- **Registry cutover.** The registry workflows run a pinned released `cadencr`
  CLI, which refuses `kind: plugin` until a CLI built from this change is
  released, qualified and pinned (`docs/MARKETPLACE_RELEASE_CONFIG.md`). Only
  after that can a plugin be submitted.
- **Official plugins.** `scripts/official-plugin-prepare.py`,
  `official_plugin_pack.py` and the tag globs know the three single kinds only.
  An official multi-kind plugin needs them extended.
- **Local authoring.** A Cadencr authoring project targets one kind
  (`projects.authoring_target`). Authoring a plugin from the app, and local
  (non-marketplace) multi-kind folders, are not covered.
- **Atomicity.** A plugin install is a sequence of member installs. A failure
  leaves earlier members installed and reports the failing member. Retrying is
  idempotent.
