# YAML language server candidate

## Status

- Package `0.1.0`; minimum app `0.16.1`.
- **Qualification pending.** Source acquisition is not semantic, host-integration or cross-platform qualification.
- No app release, production catalogue/feed activation, package publication, or install-time npm operation is authorized by these files.

## Upstream and runtime

| Parameter | Value |
| --- | --- |
| Upstream | `yaml-language-server@1.23.0` |
| Runtime | Existing Node.js `>= 20.0.0`; validation baseline `22.19.0` |
| Final package entry | `adapter/adapter.mjs` |
| Upstream command wrapper | `node_modules/yaml-language-server/bin/yaml-language-server` |
| Arguments | `--stdio` |
| Complete source files | 2,159 |
| Expanded source bytes | 19,766,619 |

The package adapter launches the original upstream command wrapper with the same Node runtime and declared arguments. The extensionless upstream file remains unchanged; `adapter/adapter.mjs` provides the package’s JavaScript entrypoint.

## Requirements

- Pinned supported 1.23.0 baseline; network schema stores require explicit user configuration.

## Reproduction

`payload/npm-lock.json` pins the full production graph. `payload/source-lock.json` records exact official npm URLs, SHA256 digests and every extracted regular file. `payload/provenance.json` preserves npm SHA512 integrity, licenses, repositories, engine ranges and lifecycle declarations. All upstream license/notice files remain in the full candidate tree. No lifecycle script executes. Optional packages omitted or selected are explicitly listed in provenance.

The private acquisition command is:

```sh
python3 -B scripts/lsp-catalog-prepare/node_acquire.py \
  --npm-lock plugins/lsp/yaml-language-server/payload/npm-lock.json \
  --id yaml-language-server --entry node_modules/yaml-language-server/bin/yaml-language-server \
  --cache /absolute/private/npm-cache \
  --output /absolute/private/new-candidate
```

Set `REVIEWED_SOURCE_COMMIT` to the reviewed full 40-character commit containing the overlay files, then bind the overlay:

```sh
python3 -B scripts/lsp-catalog-prepare/node_overlay.py \
  --source-commit "$REVIEWED_SOURCE_COMMIT" \
  --recipe plugins/lsp/yaml-language-server/recipe.json \
  --candidate /absolute/private/new-candidate
```

The overlay adds the reviewed notices and any declared adapter, then records the final entry in the resulting source lock. It does not change the acquired upstream files.

Canonical archives must be prepared by the pinned released Linux CLI and then exercised unchanged on macOS ARM, macOS Intel and Linux x86_64. Archive bytes are deliberately absent until that preparation is qualified.

## License inventory

The reviewed overlay includes `THIRD_PARTY_NOTICES.txt` and `license-audit.json`. Every original notice is retained. Supplemental notices use exact upstream commits or the locked README. Packages that publish only an SPDX license declaration are explicitly labeled; published author metadata is preserved without inventing a copyright owner/year. SPDX standard template text remains labeled as a template. These metadata-only cases remain visible for review in `recipe.json`.
