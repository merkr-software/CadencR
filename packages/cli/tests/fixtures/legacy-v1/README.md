# Frozen CLI legacy-v1 oracles

These are immutable compatibility evidence, not Rust-generated expectations. Captured on
2026-10-17 with Node `v22.19.0`, from repository commit
`60f3ae9e8bfe249ddec37a183f64e4f86b7ae716`. Do not regenerate these as part of tests.
A contract change requires explicit review of both old wire behavior and the new behavior.
No private keys or generated key pairs are stored here.

## Captured outputs

| Fixture                          | Capture procedure                                                                                                                                                                                                                   | SHA-256                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `signing-payload.canonical.json` | Legacy `lib.mjs` `canonicalJson` applied to the example-provider fixture in a schema-v1 index, `generated_at=2026-10-17T12:00:00Z`, `expires_at=2026-10-18T12:00:00Z`; no trailing newline                                          | `87287672521f5d61f5af3b3e87daf15e260516ef9d406141a721a2522923c11f` |
| `binary-argument-policy.json`    | For each of the original 19 signing-test arguments, clone that payload, set every binary target's `args` to `[argument]`, record whether legacy `validateIndex(payload, {now: new Date('2026-10-17T12:01:00Z')})` returns no errors | `a7f20a54972567eb56af06b92b828b15181367d9635f234a64a23ece7a608e79` |
| `provider.tar`                   | Run legacy `pack-provider.mjs` on exactly the staging contents and metadata constructed by `packaging.rs::Fixture::new`, target `darwin-aarch64`, then decode gzip with Node `gunzipSync`                                           | `418003582162f591358df410f7336251843509aeb4abfa1cf86ad11487201beb` |

`provider.tar` was independently inspected with system `tar -tvf` and Python `tarfile`:
ordered entries are `LICENSE`, `README.md`, `assets/`, `assets/icon.svg`, `bin/`,
`bin/provider`; every UID/GID/mtime is zero; directories and executable are `0755`,
other files `0644`. Every file's contents were compared with the test's literal bytes.
The Rust test compares the complete decoded tar, including headers, padding and terminators.
Gzip bytes are intentionally not frozen: compressor differences were already excluded by
this test's original decoded-tar comparison. Receipt target, archive path, actual compressed
size and SHA-256 remain asserted separately.

## Legacy source fingerprints

All paths below are relative to `tooling/marketplace-registry/` at the commit above.

| Source                                                 | SHA-256                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `scripts/lib.mjs`                                      | `77ade63a7e1fd43820385cca7143b670bb7a824bc650be31732560c67dd09f19` |
| `scripts/pack-provider.mjs`                            | `6fc73a1cf7f646af500639e70bc018d0652e20c8265aaff8a55451914b626843` |
| `scripts/pack-provider/archive.mjs`                    | `efc493cee4170c9410ff271d0a0ca21a12d194e9a9eae45ce77999e1a1441ae1` |
| `schemas/managed-provider-package-v1.schema.json`      | `4180ad80c8d969889aa7924a25af351787057338a787e1e3020483bc6dea3be5` |
| `schemas/signed-managed-provider-index-v1.schema.json` | `0acc58da8f40f7f5743dc066ba0c08f01c4d28cd9fc83cb7b363251a8bb79b97` |
| `tests/fixtures/example-provider.json.fixture`         | `9d068175ae9b5afb66b1714c759fa5aa332b122ecc4d3cd9b527be7b697ca698` |

## Dynamic interoperability

Dynamic CLI tests use shared Rust validation/canonical serialization to prepare current
payloads, then Node built-in `crypto` signs the exact supplied bytes independently. The
fixed canonical fixture separately checks serialization against the legacy implementation;
Node is no longer used as a runtime registry business-logic oracle. The example-provider
JSON remains a static input dependency, not executable legacy code.

## Publication pipeline schema rejection capture

`pipeline-schema-rejections.json` freezes seven additional schema-v1 cases from the same
commit and Node version above. SHA-256:
`0f3515aa75f476d24f84fd4d7e6b97c2164fb315d123133097912a2c0fdd6bcb`.
The legacy source `scripts/publication/pipeline.mjs` had SHA-256
`8293567dd0fdf9643f55fbdae068f843aa902e72cd38eaf156fe88b8bc76ac47`.

For each case, clone the file's exact fixed `base_request`, add `value` at its `path`,
and save with Node `JSON.stringify` without a newline. Call legacy `runPublicationPipeline`
with `requestFile` pointing there, a nonexistent `js-state` directory, repository
`cadencr/registry`, registry commit `b` repeated 40 times, `privateKeyFile` pointing to a
nonexistent `private.pem`, and `confirmRequestSha256` equal to the exact request-file hash.
Supply the same ten-method fail-on-network client from the original `publish_registry.rs`
test (`ensurePublicationTag`, `findRelease`, `createDraft`, `listAssets`, `uploadAsset`,
`verifyAsset`, `getTagCommit`, `publishDraft`, `getDiscovery`, `setDiscovery`), with a call
counter. Record the exact thrown message, call count, and state-directory existence.

Captured cases are explicit null, boolean, number, array, and object `registry_commit`, plus
unknown publication/request fields. All reject during schema validation, with no network
calls and no state directory, even without any key files. Fixed dates do not require clock
mocking: these schema failures precede publication-window validation. Tests normalize only
the live request dates to check that the capture's base schema still matches, then apply
every captured mutation to the live request and require the existing Rust schema diagnostic
before credentials/state writes. The separate accepted absent/string commits and all other
CLI negative checks remain live assertions.
