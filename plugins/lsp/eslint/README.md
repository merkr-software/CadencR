# ESLint candidate

## Status

- Package `0.1.0`; minimum app `0.16.1`.
- **Qualification pending.** Source acquisition is not semantic, host-integration or cross-platform qualification.
- No app release, production catalogue/feed activation, package publication, or install-time npm operation is authorized by these files.

## Upstream and runtime

| Parameter | Value |
| --- | --- |
| Upstream | `vscode-langservers-extracted@4.10.0` |
| Runtime | Existing Node.js `>= 22.0.0`; validation baseline `22.19.0` |
| Entry | `node_modules/vscode-langservers-extracted/bin/vscode-eslint-language-server` |
| Arguments | `--stdio` |
| Complete source files | 4,970 |
| Expanded source bytes | 80,903,246 |

## Requirements

- Requires project ESLint and its configuration/plugins; the server distribution does not include ESLint.
- Host must implement ESLint workspace configuration and custom client requests; validate actual diagnostics before qualification.

## Reproduction

`payload/npm-lock.json` pins the full production graph. `payload/source-lock.json` records exact official npm URLs, SHA256 digests and every extracted regular file. `payload/provenance.json` preserves npm SHA512 integrity, licenses, repositories, engine ranges and lifecycle declarations. All upstream license/notice files remain in the full candidate tree. No lifecycle script executes. Optional packages omitted or selected are explicitly listed in provenance.

The private acquisition command is:

```sh
python3 -B scripts/lsp-catalog-prepare/node_acquire.py \
  --npm-lock plugins/lsp/eslint/payload/npm-lock.json \
  --id eslint --entry node_modules/vscode-langservers-extracted/bin/vscode-eslint-language-server \
  --cache /absolute/private/npm-cache \
  --output /absolute/private/new-candidate
```

Canonical archives must be prepared by the pinned released Linux CLI and then exercised unchanged on macOS ARM, macOS Intel and Linux x86_64. Archive bytes are deliberately absent until that preparation is qualified.

## Reviewed first-party adapter

The actual candidate entry is `adapter/adapter.mjs` with arguments `(none)`. The upstream entry above remains unchanged inside the dependency tree. `recipe.json` records both entries. Adapter source is Apache-2.0; all upstream MIT notices remain preserved.

`node_overlay.py` must bind the listed adapter files to their actual reviewed Git commit before canonical packing. The upstream-only source lock currently remains a pending acquisition record until that immutable overlay is appended.

## License inventory

The reviewed overlay includes `THIRD_PARTY_NOTICES.txt` and `license-audit.json`. Every original notice is retained. Supplemental notices use exact upstream commits or the locked README. Packages that publish only an SPDX license declaration are explicitly labeled; published author metadata is preserved without inventing a copyright owner/year. SPDX standard template text remains labeled as a template. These metadata-only cases remain visible for review in `recipe.json`.
