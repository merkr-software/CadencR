# GraphQL language server candidate

## Status

- Package `0.1.0`; minimum app `0.16.1`.
- **Qualification pending.** Source acquisition is not semantic, host-integration or cross-platform qualification.
- No app release, production catalogue/feed activation, package publication, or install-time npm operation is authorized by these files.

## Upstream and runtime

| Parameter | Value |
| --- | --- |
| Upstream | `graphql-language-service-cli@4.0.1` |
| Runtime | Existing Node.js `>= 22.19.0`; validation baseline `22.19.0` |
| Entry | `node_modules/graphql-language-service-cli/bin/graphql.js` |
| Arguments | `server -m stream` |
| Complete source files | 10,099 |
| Expanded source bytes | 134,315,905 |

## Requirements

- Includes GraphQL 17.1.0 peer runtime. Requires project schema/configuration; remote schema fetching is excluded from offline qualification.

## Reproduction

`payload/npm-lock.json` pins the full production graph. `payload/source-lock.json` records exact official npm URLs, SHA256 digests and every extracted regular file. `payload/provenance.json` preserves npm SHA512 integrity, licenses, repositories, engine ranges and lifecycle declarations. All upstream license/notice files remain in the full candidate tree. No lifecycle script executes. Optional packages omitted or selected are explicitly listed in provenance.

The private acquisition command is:

```sh
python3 -B scripts/lsp-catalog-prepare/node_acquire.py \
  --npm-lock plugins/lsp/graphql-language-server/payload/npm-lock.json \
  --id graphql-language-server --entry node_modules/graphql-language-service-cli/bin/graphql.js \
  --cache /absolute/private/npm-cache \
  --output /absolute/private/new-candidate
```

Canonical archives must be prepared by the pinned released Linux CLI and then exercised unchanged on macOS ARM, macOS Intel and Linux x86_64. Archive bytes are deliberately absent until that preparation is qualified.

## Engine declarations

Only Node.js 22.19.0 is qualified. The scalar minimum is a prerequisite lower bound. The adapter also checks every locked dependency engine range before launch; the current intersection includes Node 22.18+, Node 24.11+ and supported newer even majors, with the exact declarations recorded in `adapter/config.json`. Node 23 and Node 24.0 do not satisfy that graph and receive an explicit unsupported-runtime error.

## License inventory

The reviewed overlay includes `THIRD_PARTY_NOTICES.txt` and `license-audit.json`. Every original notice is retained. Supplemental notices use exact upstream commits or the locked README. Packages that publish only an SPDX license declaration are explicitly labeled; published author metadata is preserved without inventing a copyright owner/year. SPDX standard template text remains labeled as a template. These metadata-only cases remain visible for review in `recipe.json`.
