# CLI 0.15.4 qualification for official provider releases — 2026-11-02

> The exact distributed Linux ELF passed provider-author publication/recovery qualification and 91 general offline checks. This record scopes the evidence for the Cursor release path; it does not repeat the historical thirteen-gate policy/renewal campaign.

## Distributed binary

| Binding           | Value                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Public release    | [cli/v0.15.4](https://github.com/merkr-software/CadencR/releases/tag/cli/v0.15.4)                                       |
| CLI source commit | `3ebb603160d9dcf054adbb6315c68cb8702cf7ce`                                                                              |
| Build/publish run | [41532088025](https://github.com/merkr-software/CadencR/actions/runs/41532088025), attempt 1                            |
| Binary            | `cadencr-v0.15.4-x86_64-unknown-linux-gnu`, 6,088,520 bytes                                                             |
| Binary SHA-256    | `d925f203c3fd2e51621ad00ef1413bb25fdf8bc25792dbec9d5d2a67b1d4244d`                                                      |
| Dry run           | [41530888046](https://github.com/merkr-software/CadencR/actions/runs/41530888046); binary byte-identical to publication |

The four public assets (binary, checksum list, binary pin and provenance) were downloaded and compared byte-for-byte to the approved publication candidate. The tag and provenance resolve to the source commit above. The CLI release is public, immutable, not a prerelease, and not Latest.

## Reviewed QA inputs

| Binding                   | Value                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fixed QA repository       | `merkr-software/cadencr-registry-qa`, ID `1420296872`                                                                       |
| Fixture source            | `d038e040cddba615891da19a24e362c1cf7abeb3`                                                                                  |
| Fixture identity          | Inert `qa-author-provider` version `1.0.8`                                                                                  |
| Immutable source tag      | `qa-author-cli/stable-0154-provider-20261102`                                                                               |
| Workflow/candidate commit | `a92aa8b1047bb55e355ea3c822a8ec50b7569bb2`                                                                                  |
| Candidate JSON SHA-256    | `bddacea217c32f946ac1d27538d855732eadd4755078f0ca37ae04ca48f1f333`                                                          |
| Author request SHA-256    | `613bd6c36541a8de3e185c88a52d260db1757d11ee5d76d5d1b6a1065ca99890`                                                          |
| Public QA release         | [432016965](https://github.com/merkr-software/cadencr-registry-qa/releases/tag/qa-author-cli/stable-0154-provider-20261102) |

The existing QA harness was retained; only the inert fixture version and reviewed candidate/pin data changed. Local harness tests passed 23 cases, with the two distributed-execution checks skipped locally. These synthetic tests are not the released-ELF evidence below.

## Passed distributed-binary gates

All four runs concluded success on attempt 1 and independently fetched the exact published ELF with no source-built fallback. Offline execution used a networkless namespace and an empty credential environment.

| Gate                                              | Run                                                                                           | Retained proof JSON SHA-256                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| General offline: 91 checks                        | [41533194379](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41533194379) | `0e8cbe2a3bbc5b924047e2499432aa46031c9d7315084eb57030a824e374c825` |
| Provider offline                                  | [41533201021](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41533201021) | `11546020d22956bb44bcc7fc1042213b76add6ec1fec0de9a6759d029926f740` |
| Provider publication and interrupted draft resume | [41533531159](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41533531159) | `2b2202bb0412e31bb6ae723aec116b70afb72ea15b68ba5c70a5688c430fbe96` |
| Provider fresh runner                             | [41533875719](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41533875719) | `02dfebd5b1d115bbf91b18474445f6997004ac00f049d8e7eee28496f857d81b` |

- General offline checks cover provider, theme and tab metadata, packaging, signatures and rejection boundaries. The proof correctly reports `offline-only` and `lifecycle_qualified: false`.
- Provider author inspection passed, and a wrong request confirmation was rejected before publication.
- The first public run observed an empty bound draft, terminated only its owned CLI process, and resumed the exact request on the same release ID. It verified same-state and fresh-scratch retries, all public asset bytes, and changed-byte/request rejection without inventory changes.
- The separate fresh-runner dispatch reconstructed the same request and complete remote inventory. It records `interrupted_draft: not_exercised`; the interruption evidence belongs to the first public run.
- Both public proofs retain release ID `432016965`, identical asset IDs/checksums and two completed retries.

## Preserved public QA inventory

| Asset                          | GitHub asset ID | SHA-256                                                            |
| ------------------------------ | --------------- | ------------------------------------------------------------------ |
| metadata.json                  | `703322345`     | `84b7f31282dd3d258e7011972c421dc0fa2dc2e3bcb81b7e2b934434e2bc0c16` |
| provider-darwin-aarch64.tar.gz | `703322507`     | `52960216e0a5d72484ea49cd5dfd05efbc05b4d5b24715ed02178395bae1dbed` |
| provider-linux-x86_64.tar.gz   | `703322202`     | `52960216e0a5d72484ea49cd5dfd05efbc05b4d5b24715ed02178395bae1dbed` |

## Promotion and limits

- Monorepo author, qualification and registry-template pins select this exact binary. Author policy binds the pin and qualification file hashes; repository identity, account, environment ID and reviewer policy are preserved.
- The source diff from CLI 0.15.2 adds multi-export packages, an optional theme chart color and the narrowly reviewed official Cursor identity admission. GitHub transport, author publication/retry state machines and authority primitives are unchanged. The security follow-up found no serious gap requiring the old thirteen gates to be repeated for the provider-author path.
- The deployed registry runtime pin is promoted separately with its own reviewed change. Pin promotion alone is not a Cursor publication or signed-catalog authorization.
- This record exercises Linux x86_64 CLI behavior with inert fixtures, never the fixture executables. It does not establish native Cursor conformance, real Cursor prompts, managed installation or client/UI behavior. Those remain separate release checks.
- No production signing keys, tokens or private scratch were included in retained proofs. Prior tags, releases, assets, discovery branches and databases were preserved.
