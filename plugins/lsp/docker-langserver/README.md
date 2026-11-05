# Dockerfile language server candidate

## Status

- Package `0.1.0`; minimum app `0.16.1`.
- **Qualification pending.** Source acquisition is not semantic, host-integration or cross-platform qualification.
- No app release, production catalogue/feed activation, package publication, or install-time npm operation is authorized by these files.

## Upstream and runtime

| Parameter | Value |
| --- | --- |
| Upstream | `dockerfile-language-server-nodejs@0.15.0` |
| Runtime | Existing Node.js `>= 20.0.0`; validation baseline `22.19.0` |
| Final package entry | `node_modules/dockerfile-language-server-nodejs/lib/server.js` |
| Upstream command wrapper | `node_modules/dockerfile-language-server-nodejs/bin/docker-langserver` |
| Arguments | `--stdio` |
| Complete source files | 341 |
| Expanded source bytes | 2,452,199 |

The final entry is the same upstream JavaScript server module loaded by the original command wrapper. All upstream files remain unchanged.

## Requirements

- Standard LSP stdio transport; actual language features remain to be qualified.

## Reproduction

`payload/npm-lock.json` pins the full production graph. `payload/source-lock.json` records exact official npm URLs, SHA256 digests and every extracted regular file. `payload/provenance.json` preserves npm SHA512 integrity, licenses, repositories, engine ranges and lifecycle declarations. All upstream license/notice files remain in the full candidate tree. No lifecycle script executes. Optional packages omitted or selected are explicitly listed in provenance.

The private acquisition command is:

```sh
python3 -B scripts/lsp-catalog-prepare/node_acquire.py \
  --npm-lock plugins/lsp/docker-langserver/payload/npm-lock.json \
  --id docker-langserver --entry node_modules/dockerfile-language-server-nodejs/lib/server.js \
  --cache /absolute/private/npm-cache \
  --output /absolute/private/new-candidate
```

Set `REVIEWED_SOURCE_COMMIT` to the reviewed full 40-character commit containing the overlay files, then bind the overlay:

```sh
python3 -B scripts/lsp-catalog-prepare/node_overlay.py \
  --source-commit "$REVIEWED_SOURCE_COMMIT" \
  --recipe plugins/lsp/docker-langserver/recipe.json \
  --candidate /absolute/private/new-candidate
```

The overlay adds the reviewed notices and any declared adapter, then records the final entry in the resulting source lock. It does not change the acquired upstream files.

Canonical archives must be prepared by the pinned released Linux CLI and then exercised unchanged on macOS ARM, macOS Intel and Linux x86_64. Archive bytes are deliberately absent until that preparation is qualified.

## License inventory

The reviewed overlay includes `THIRD_PARTY_NOTICES.txt` and `license-audit.json`. Every original notice is retained. Supplemental notices use exact upstream commits or the locked README. Packages that publish only an SPDX license declaration are explicitly labeled; published author metadata is preserved without inventing a copyright owner/year. SPDX standard template text remains labeled as a template. These metadata-only cases remain visible for review in `recipe.json`.
