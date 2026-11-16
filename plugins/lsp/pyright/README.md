# Pyright candidate

## Status

- Package `0.1.0`; minimum app `0.16.1`.
- **Qualification pending.** Source acquisition is not semantic, host-integration or cross-platform qualification.
- No app release, production catalogue/feed activation, package publication, or install-time npm operation is authorized by these files.

## Upstream and runtime

| Parameter | Value |
| --- | --- |
| Upstream | `pyright@1.1.414` |
| Runtime | Existing Node.js `>= 20.0.0`; validation baseline `22.19.0` |
| Entry | `node_modules/pyright/langserver.index.js` |
| Arguments | `--stdio` |
| Complete source files | 5,423 |
| Expanded source bytes | 19,457,120 |

## Requirements

- Bundled fallback typeshed is retained in full. Python interpreter discovery can improve environment-specific imports.

## Reproduction

`payload/npm-lock.json` pins the full production graph. `payload/source-lock.json` records exact official npm URLs, SHA256 digests and every extracted regular file. `payload/provenance.json` preserves npm SHA512 integrity, licenses, repositories, engine ranges and lifecycle declarations. All upstream license/notice files remain in the full candidate tree. No lifecycle script executes. Optional packages omitted or selected are explicitly listed in provenance.

The private acquisition command is:

```sh
python3 -B scripts/lsp-catalog-prepare/node_acquire.py \
  --npm-lock plugins/lsp/pyright/payload/npm-lock.json \
  --id pyright --entry node_modules/pyright/langserver.index.js \
  --cache /absolute/private/npm-cache \
  --output /absolute/private/new-candidate
```

Canonical archives must be prepared by the pinned released Linux CLI and then exercised unchanged on macOS ARM, macOS Intel and Linux x86_64. Archive bytes are deliberately absent until that preparation is qualified.

## License inventory

The reviewed overlay includes `THIRD_PARTY_NOTICES.txt` and `license-audit.json`. Every original notice is retained. Supplemental notices use exact upstream commits or the locked README. Packages that publish only an SPDX license declaration are explicitly labeled; published author metadata is preserved without inventing a copyright owner/year. SPDX standard template text remains labeled as a template. These metadata-only cases remain visible for review in `recipe.json`.
