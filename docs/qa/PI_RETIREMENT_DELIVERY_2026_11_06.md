# Pi retirement delivery evidence — 2026-11-06

## Exact source and intent

Canonical integration branch: `feat/pi-retirement-signed-handoff` in
`/private/tmp/cadencr-pi-retirement-canonical-20261106`, based on exact PR #381 main
`ebd19991470b15aff76ea61bfed0f39e8318bb60`. The earlier development checkout
`feat/pi-handoff-compatible-channel` at `/private/tmp/cadencr-pi-handoff-integration-20261106`
is retained. Its tested Rust source/manifest bytes are identical to this integration.
The only overlaps with PR #381 were the official policy and its test: remove
`provider-pi` while retaining every other entry, including all 25 LSP sources.
The relevant source-retirement scripts were rerun on this canonical base:
65 tests, 59 passed, 6 skipped, zero failures.

Retirement patch `229d9c59f` is included without modifying its original worktree or
database. No staging, commit, release or publication has occurred. CLI version
records remain `0.15.6`; the proposed next version is not reserved or published.

## Automated macOS checks

| Check                                                         | Result                                                           | Reproducible command/log                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared core                                                   | 169 passed                                                       | `pnpm rust -- test -p cadencr-registry-core`                                                                                                                                                           |
| Publisher                                                     | 222 passed                                                       | `pnpm rust -- test -p cadencr-registry-publisher`                                                                                                                                                      |
| CLI, including integration suites                             | 110 passed                                                       | `pnpm rust -- test -p cadencr-cli`                                                                                                                                                                     |
| Managed service domains                                       | 239 passed, 2 ignored                                            | `pnpm rust -- test -p cadencr-service --lib managed`                                                                                                                                                   |
| First-event crash regression                                  | Passed                                                           | `pnpm rust -- test -p cadencr-service --lib first_runtime_event_persists_and_emits_the_bound_id_before_any_close`                                                                                      |
| Tools/service Clippy                                          | Passed                                                           | `pnpm rust -- clippy <affected packages> --all-targets -- -D warnings`; service `--lib --tests`                                                                                                        |
| Desktop marketplace, hooks, UI components and terminal resume | 86 passed across 4 files                                         | `pnpm --filter @cadencr/desktop exec vitest run src/lib/marketplace.test.ts src/lib/provider-resume-command.test.ts src/hooks/useMarketplace.test.tsx src/components/marketplace/Marketplace.test.tsx` |
| Desktop TypeScript, lint and knip                             | Passed                                                           | `tsc --noEmit` (temporary build-info path), `pnpm --filter @cadencr/desktop lint`, `pnpm --filter @cadencr/desktop knip`                                                                               |
| Protected workflow and new orchestration                      | 98 passed, including final legacy-channel coexistence regression | `CADENCR_REGISTRY_TEST_CLI=<integration>/target/debug/cadencr node tooling/marketplace-registry/tests/run.mjs`                                                                                         |
| Registry contribution, evidence and CI                        | 7 passed                                                         | `CADENCR_TEST_CLI=<integration>/target/debug/cadencr node --test tests/*.test.mjs` in registry                                                                                                         |
| Exact administrative validation                               | Passed                                                           | `cadencr registry validate --base <accepted registry> --candidate <registry worktree> --administrative`                                                                                                |

Node `22.19.0` was used for application checks. Rust commands use `pnpm rust` and
isolated worktree targets. Complete logs are task-owned under `/private/tmp/`:
`pi-integration-tools-final.log`, `pi-integration-managed-latest.log`,
`pi-integration-event-test2.log`, `pi-integration-*-clippy-*.log`,
`pi-integration-desktop-final.log`, `pi-registry-tests-latest.log`.
A macOS check does not prove a Linux or packaged-client result.

## Live development service with trusted fixtures

`pnpm dev` runs the service and desktop in a task-owned process group with:

- New database: `/private/tmp/pi-retirement-client-qa-y97zw9zl/qa.db`.
- New settings, home and application profile; no copied user database/settings.
- Frontend `http://127.0.0.1:52951/`, service `http://127.0.0.1:52952/`.
- Fresh Ed25519 key `pi-retirement-QA-only`, compiled only into this local build.
- Two task-generated signed fixtures based on retained historical metadata:
  before retirement and after adding the exact reviewed handoff. These are not
  production signatures or publication assets. No contributor executable is run.

Real authenticated API results:

1. Health/catalog/inventory returned HTTP 200; six historical catalog entries
   authenticated with cache status `verified`.
2. Loading the signed retirement fixture kept the complete original envelope and
   all six package entries, but removed `pi` from provider recommendations.
3. Real install requests for `pi 0.4.0` and `pi 0.4.1` both returned HTTP 409,
   `MANAGED_PACKAGE_NOT_FOUND`, before artifact download/probing.

Requests/responses, fixture preparation, compile configuration and dev logs are
retained in that task directory. This proves API behavior, **not UI interaction**.

## Development UI verification completed

The initial Chrome DevTools/CUA blocker was real and is retained as history:
Chrome DevTools MCP could not launch into its occupied shared profile, and CUA
initially had no browser surface. On the later authorized QA resumption, native
CUA could control Chrome. It opened a new task-only localhost tab and used Chrome's
own Console through its menu. Integrated Cadencr Browser tools were never used to
bypass their prohibition on automating Cadencr itself. No foreign browser was killed.

**Five targeted development UI cases passed on macOS 27.0.1 ARM64.**

| Case                           | Observed result                                                                                                                                                  | Retained screenshot                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Before retirement              | Pi by cadencr, both 0.4.0/0.4.1, recommended 0.4.1                                                                                                               | `before-pi-offer.jpg`                                  |
| Stale installation action      | Clicking Install after the signed retirement advances shows `MANAGED_CATALOG_INVALID: refusing an older signed catalog publication`; HTTP 422 appears in Console | `stale-install-refused.jpg`                            |
| Refresh and search             | Cursor remains as Providers 1; provider-filtered Pi search gives Providers 0 / Nothing matches                                                                   | `after-marketplace.jpg`, `retired-provider-search.jpg` |
| Direct Pi URL                  | This plugin is not in the catalog or installed; no install action                                                                                                | `retired-direct-link.jpg`                              |
| Invalid signature and recovery | Explicit signature verification error / No verified catalog right now; Try again accepts a newer valid signed retirement, with Cursor only                       | `invalid-signature.jpg`, `renewed-retirement.jpg`      |

Evidence directory:
`/private/tmp/pi-retirement-client-qa-y97zw9zl/ui-2026-11-06T20-05-47-711Z`.
The report is `QA_REPORT.md`; the primary `evidence-manifest.json` binds 41 files,
SHA-256 `6c108441ee8bee880652ab8508c1453471644997ccacd11d9ab289b627da74e2`.
Supplementary exact harness source copies are bound by `harness-manifest.json`.
Native JPEG bytes were preserved without image edits. Accessibility checkpoints
are incremental, often only no-change/focus notes; they are not full-DOM assertions.
Live native observations and visually inspected screenshots are the UI evidence.

The original QA DB/settings were reused and retained. Expired earlier fixtures
are archived. A new fixture-only key `pi-retirement-UI-QA-only` was compiled in a
single serial service build (54.27 seconds); its private key stays local at mode
0600 and is excluded from evidence inventory/publication. The service was then
reused with the renderer dev task. Binary SHA-256:
`fd1ae04f6704f1f165dd1b261d71faa7b4a5aaec67409a83ceeabc6c50993687`.

Synthetic Pi archive URLs use closed HTTPS loopback port 9; the retirement digests
were rebound to those exact inert metadata entries. No contributor executable was
downloaded or run. Final API captures authenticate the envelope, preserve all six
package entries/retirement records, and omit Pi recommendations. No Pi payload was
installed. These fixtures are not production catalog bytes or admission artifacts.
Provider acquisition in this UI campaign used the verified local cache with no
provider catalog URL compiled in. It does not exercise public administrative-feed
download or packaged cache migration; those retain their unit coverage and remain
packaged-client delivery gates. All 2,679 renderer source files and 1,843 Rust/
manifest files were byte-compared with the canonical integration before reporting.

The initial Console captured expected HTTP 422, dependency-symlink font 403s,
CSP/runtime-config browser notices and a transient WebSocket reconnect warning.
Final Console showed one browser-only runtime-config warning and no error badge or
uncaught exception. LSP/theme/tab feeds were deliberately unconfigured; those
notices remain in captures and are not qualifications of those catalog kinds.

Only our tab/DevTools and tracked service/frontend groups were closed; the LSP and
previous personal tab were confirmed present, and graceful service shutdown was
recorded. Databases/settings/fixtures remain. This is **development browser UI QA**;
packaged macOS/Linux and real installed-session lifecycle remain separate gates.

## Release and publication gates

- Final reviewer clearance, scoped hooks and Linux CI against the eventual commits.
- Concrete `finish-job` commit-plan approval before staging/commits.
- Release T2 confirmation for proposed CLI `0.15.7`, actual main integration/green
  checks, T5 dry run and T6 explicit go plus human protected-environment approval.
- Compatible macOS/Linux packaged-client QA and reviewed desktop release coordinated
  with the proposed application `0.16.1` preparation; no implicit LSP production activation.
- Exact authenticated branch seed, refreshed request/baseline/head/digest review,
  protected signed retirement publication and independent public/client read-back.

The independent Pi `0.5.0` candidate remains held for separate maintainer review.
Its suspended execution/admission is not a prerequisite for retirement.

## LSP publication coordination history

Operator evidence refreshed 2026-11-06 13:43 UTC:

- Canonical main `ebd19991470b15aff76ea61bfed0f39e8318bb60` (PR #381).
- CI run `42223961692`, attempt 2: 12/12; CodeQL `42223961663`: successful.
- A strictly serial 24-package series is owned by `qa0156_public`; first signed
  tag `lsp-astro-ls-v0.1.0` binds that main, inspection run `42227651726`.
- Until the operator explicitly releases the gate, no main merge, remote CLI pin,
  policy/workflow change or competing author dispatch is permitted. Local work,
  read-only inspection and review preparation can continue.
- LSP uses the actual qualified CLI `0.15.6`; it reserves no `0.15.7` version.
  Our `0.15.7` is only a proposal pending release T2 confirmation and fresh remote
  availability checks. No app release/changelog `0.16.1` is owned or approved by
  LSP; this task can centralize preparation, subject to normal release gates.
- LSP does not change Pi or production feeds/variables. Its post-publication QA
  feed is private; production legacy LSP remains empty. Future administrative
  channel activation is compatible and separately reviewed.

The operator later explicitly completed all 24 new publications and lifted the
series freeze. Its retained `root-verified-public-releases.json` was independently
hashed at `9ac42513f70c3df286cab54c8d6b749b9a6d0df293535ec99273e8cf0d6b219a`.
The local file is under `/private/tmp/cadencr-official-lsp-serial-20261106-ebd1999`.
This confirms the received manifest bytes; anonymous asset downloads were not
repeated by this task. All immutable `lsp-*-v0.1.0` tags remain bound to P and
must never be retagged or republished. The completed series does not approve
Pi commits, version bumps, app release, admission or protected publication.

## Independently authenticated prior CLI proof

The public CLI `0.15.6` proof manifest was fetched independently from
https://raw.githubusercontent.com/merkr-software/cadencr-registry-qa/cfb92d0c9232aabdd7c6ea417a1f63179ac4fe70/requests/cli0156/proofs/manifest.json
and its exact bytes have SHA-256
`945ba5a2f06760b733185018464b7d5a469ac31d7a81de3b44d2024d492e03f5`.
The retained local copy is `/private/tmp/pi-retirement-cli0156-proof-manifest.json`.
It authenticates prior proof inventory, not this future CLI or Pi candidate.
The operator separately reports released matrix run `42215738947` passed 25/25
on Ubuntu 22.04/24.04 x86-64 and macOS 15 ARM/Intel; that report has not yet been
independently downloaded here. Preserve all `cli0155`/`cli0156` profiles/proofs.
Prepare fresh isolated requests/profiles for the eventually approved next version,
then qualify its actual distributed binary. No version/pin promotion is inferred.

## Canonical PR381 base verification

All 1,843 tracked/current Rust source files and Cargo manifests/lockfile were
byte-compared with the tested development integration and are identical. The
comparison inventory is `/private/tmp/pi-canonical-rust-equivalence.json`.
The full registry-template suite and four desktop suites were rerun on the
canonical worktree; see `pi-canonical-template-tests.log` and
`pi-canonical-desktop-tests.log` in `/private/tmp`. These checks preserve the
LSP main/source boundary and do not imply production deployment or UI QA.

## Historical plugin-membership regression

An additional boundary review reproduced an unreleased-contract defect: filtering
retired standalone entries before member-ownership validation could allow the
successor identity to become a plugin member, while ordinary contributions reject
that reassignment. The new test failed before the fix with an accepted prepared
payload. The fix reuses `plugin_package::validate_member_ownership` on the complete
historical package set whenever handoff records exist, alongside historical name
collision validation. No general continuity or signature check is relaxed.

Full tools rerun after the fix: core 170, publisher 222 and CLI 110 passed;
all-target tools Clippy passed. Logs: `pi-handoff-plugin-regression-red.log`,
`pi-integration-tools-plugin-fixed.log`, `pi-integration-tools-plugin-clippy.log`.
The full service suite passed again against the final stricter core: 4,298 tests,
zero failures and 3 ignored in 98.77 seconds. Final log:
`/private/tmp/pi-integration-service-full-final.log`.
The initial task-only stack was stopped while browser automation was unavailable.
The subsequent authorized native-CUA UI campaign and its cleanup are documented
above; all QA database/settings/fixture generations and logs remain preserved.
