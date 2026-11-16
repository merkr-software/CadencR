# Archived legacy pipeline evidence

## Scope and authority

- Captured from original JavaScript `runRegistryPublisher` and its original archive/discovery downloaders at base revision `620cf847e`, using Node `v22.19.0` against **loopback fake GitHub only**. No Rust publisher generated these bytes.
- `none.json.gz`, `provider.json.gz`, and `discovery.json.gz` contain exact base64 inputs, exact disk files, the original success/error result, and serialized remote protocol state/request traces. `hashes.json` pins both compressed bytes (`sha256`) and exact original decoded bytes (`uncompressed_sha256`) for each complete capture; `provenance.json` records original JS source SHA256s.
- `inputs/private.pem` is intentionally base64-encoded with the other exact input files. It is the **publicly known deterministic test-only key** from `pipeline/fixture.rs` (`07` repeated 32 times), not a hidden credential. It has **no production, QA, remote, or trust-root authority**. Sensitive-data review may explicitly allow this fixture key only; no real key was used.
- The fixtures are immutable historical evidence. Tests verify their full hashes and original Ed25519 signatures before adapting dates. They do not claim live Rust→JS parity or exact historical signed-byte execution after rebasing.

## Reproduce the capture

Use an isolated copy of revision `620cf847e` and compare the source hashes in `provenance.json` before capturing. No real GitHub access or credentials are needed.

1. Gunzip `none.json.gz`, then decode its `inputs` into a canonical temporary directory (`realpath`, important on macOS `/tmp`), including `request.json`, `submission.json`, `private.pem`, and `public.pem`. The input request bytes are authoritative; do not reserialize them.
2. Use the original `tooling/marketplace-registry/tests/helpers/pipeline-handoff-server.mjs`. Its existing `run` action invokes the original publisher/downloaders. Add **only** this serialization branch before `configure`:

   ```js
   if (input.action === "export") {
     return {
       ...state,
       tags: [...state.tags],
       sourceArchives: [...state.sourceArchives],
     };
   }
   ```

3. Start a new helper process for each of `none`, `provider`, `discovery`. Parse its first stdout line for `control` and `remote`. All operations below are HTTP `POST` JSON to `control`, not to GitHub.
4. Send `{"action":"configure","publicUnavailable":false,"rawUnavailable":false}` for `none`; set only `publicUnavailable` for `provider`, or only `rawUnavailable` for `discovery`.
5. Send `{"action":"run","request":"<canonical-temp>/request.json","directory":"<canonical-temp>/state","privateKey":"<canonical-temp>/private.pem"}`. Save the returned JSON as `result`.
6. Recursively enumerate regular files under `state`, sorted by relative POSIX path. Read each file without parsing/reserializing; base64-encode it as `disk[relativePath]`.
7. Send `{"action":"export"}` and save its JSON as `remote`. Native Buffer JSON is `{type:"Buffer",data:[...]}`; maps use entry arrays. Record the four exact base64 `inputs`.
8. Serialize `{result,inputs,disk,remote}` using `JSON.stringify(value, null, 2) + "\n"`. Preserve the whole raw-file SHA256 in `provenance.json` and as `uncompressed_sha256` in `hashes.json`. Losslessly gzip it using the command below and record the compressed SHA256 as `sha256`. Terminate/reap the helper.
9. Historical dates are in the request. For exact recapture after expiry, use an isolated test clock equal to `generated_at + 60 seconds` (both `Date.now()` and no-argument `new Date()`), never a production validation bypass. For a new capture with current dates, change only the two request timestamps **before** running the original legacy actor; record the new input/output hashes instead of claiming byte identity with these captures.

## Explicit test-only date adaptation

`src/pipeline/handoff/rebase.mjs` is not a publisher and imports only Node built-ins. It checks the archived full-file digest, verifies the original signature, then changes the following **explicit fields only**. A structural comparison rejects changes to every other field; every other disk/input file remains byte-identical.

| Object                            | Allowed fields                                                 |
| --------------------------------- | -------------------------------------------------------------- |
| Input request                     | `generated_at`, `expires_at`                                   |
| `pipeline-request.json`           | `request.generated_at`, `request.expires_at`, `request_sha256` |
| `managed-index.json`              | `signed.generated_at`, `signed.expires_at`, `signature.value`  |
| Catalog receipt                   | `catalog_sha256`, `catalog_size`, `catalog_url`, `release_tag` |
| Discovery receipt                 | `blob_sha`, `release_tag`, `snapshot_sha256`                   |
| Remote catalog release, index `1` | `tag_name`, `name`, catalog-hash line in `body`                |
| Remote catalog asset, index `2`   | `bytes`, `size`, `browser_download_url`                        |
| Remote tag, index `1`             | Tag name, entry `0`                                            |
| Remote discovery                  | `bytes`, `sha`                                                 |

Canonical signing bytes, Ed25519 signature, catalog SHA256/tag/URL and Git blob SHA1 are recomputed only because dates changed. JSON files in the allowlist are canonically serialized with a trailing newline. No file names change. Provider identity, package/plan/submission/archive bytes, commits, IDs, ownership and provider receipts never change. The archived request trace remains historical, not rewritten.

## Preserved assertions and limits

| Scenario                                                               | Active assertion                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed, provider-public interruption, discovery-public interruption | Archived legacy first **and** current Rust first; Rust resumes each; provider interruption permits only five ordered catalog/discovery mutations; others permit zero |
| Completed replay                                                       | Exact post-rebase disk preservation, unchanged reviewed request, no remote writes                                                                                    |
| Fresh managed recovery                                                 | Retired author sources; identical signed managed index; no remote writes; complete receipts                                                                          |
| Catalog/discovery receipt tamper                                       | Both probes fail closed with unchanged disk and zero writes                                                                                                          |
| Provider ownership                                                     | Existing release records preserved; no provider-release mutation or retired-author downloads                                                                         |
| Noncanonical manifest                                                  | Rust preserves bytes with no writes                                                                                                                                  |

The old reverse Rust→live-JS and stricter-JS noncanonical-manifest runtime assertions are intentionally **not claimed** here. They depended on the retired runtime oracle. Static legacy byte goldens elsewhere remain exact; this suite tests Rust consumption of independently captured legacy evidence and current Rust recovery, not a second Rust actor disguised as parity. `observations.json` additionally pins original JS replay/fresh success, both fail-closed receipt errors and unchanged disk, its stricter noncanonical-manifest error, and zero writes. These are archived observations, not live reverse parity. To reproduce, complete a `none` run, record stats, retire sources, replay the same state, run a fresh directory, individually replace each fresh receipt with `{}` and record result plus unchanged disk before restoring that probe, then pretty-print the original manifest and replay; record final stats. The exact separate run inputs are included in the observation file. No deployed JS business implementation is removed by this change.

## Lossless compressed storage

The three original raw JSON captures were compressed without parsing or reserializing them. Before removing the redundant raw files, bounded decompression was independently compared byte-for-byte with each original, and the original raw SHA256 was verified. Original hashes remain in `provenance.json`; no capture semantics were regenerated. `observations.json` remains plain JSON.

Reproducible command (Node `v22.19.0`, deterministic zero-mtime gzip header, compression level `9`):

```bash
node --input-type=module - capture.json <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
const path = process.argv[2];
const raw = readFileSync(path);
const compressed = gzipSync(raw, { level: 9, mtime: 0 });
assert.deepEqual(gunzipSync(compressed, { maxOutputLength: 512 * 1024 }), raw);
writeFileSync(path + ".gz", compressed);
JS
```

The loader verifies the encoded SHA256 **before** bounded `gunzipSync` (`maxOutputLength: 512 * 1024`), then verifies the original raw SHA256 **before** parsing or signature verification. Token/path/sensitive-data reviews must scan the decoded JSON and base64-decoded inputs/disk data; compression does not exempt these fixtures from review. The intentional public test signing key is documented above.
