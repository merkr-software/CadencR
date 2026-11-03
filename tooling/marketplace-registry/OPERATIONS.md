# Marketplace operational preparation

## Authority and deployment gates

v0.13.0 ships hidden UI, not a public registry launch. The next milestone publishes
reviewed themes and Pi before a future desktop activation. Procedures involving
signing, tags, feed advancement, production pins or remote writes require reviewed
targets/inputs and protected operator authority; preparation alone is insufficient.
Examples are syntax, not actual keys, destinations or assigned owners. This
template contains a daily renewal workflow and a daily expiry watch (see
[Automatic renewal and expiry watch](#automatic-catalog-and-policy-renewal-and-expiry-watch));
neither is deployed, scheduled or configured in any live repository, and both stay
inert until their repository variables exist. Earlier distributed CLI qualification is dated evidence, not
production deployment. The locally selected `0.15.2` includes
standalone Rust diagnostics and the bounded discovery-convergence correction.
Its exact distributed executable passed first-pass renewal, unchanged replays,
fresh-runner recovery and three-kind publication checks; see the
[current qualification record](../../docs/qa/MARKETPLACE_STABLE_CLI_2026_10_25.md).
The historical renewal failure remains failed and its exact cause unknown.

| Required record before activation | Accountable role / evidence                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| Renewal and backup owner          | Named maintainers, handoff and protected environment access review                         |
| Incident and revocation owner     | Named decision maker, monitored security contact and escalation backup                     |
| Alert delivery                    | Real monitored destination, failed-run subscription and acknowledged test alert            |
| Recovery                          | Reviewed offline-root custody, replacement app-delivery owner and tabletop evidence        |
| Deployment                        | Real feed URLs, protections, reviewed trust roots and populated provider/theme catalog     |
| Runtime cutover                   | Exact distributed binary qualified; three local pins selected; production adoption pending |

The owners and live controls above remain unassigned/unverified in this template.
The local contribution/publisher, author and qualification pins select the same
qualified Rust binary with no JavaScript fallback. Selection is not production
adoption or publication authority: fresh bootstrap/cutover approval, actual
bootstrap merge and hosted checks remain pending. See the
[local review record](../../docs/MARKETPLACE_CLI_PIN_REVIEW_2026-10-21.md).
Reinspect the remote default branch and follow the
[deployment sequence](README.md#remote-deployment-requires-two-reviewed-changes).
The JavaScript business implementation has been removed from this source template;
that does not deploy these changes or authorize desktop trust/feed/key changes.

## Read-only expiry and failure alert preparation

Use the **locally selected qualified Rust CLI**. Run this
read-only diagnostic against local catalog/provider/theme-policy snapshots:

```sh
cadencr registry check-metadata-expiry \
  /reviewed/snapshots/managed-index.json \
  /reviewed/snapshots/managed-blocklist.json \
  /reviewed/snapshots/managed-theme-blocklist.json
```

- Reads at most three regular non-symlink files, each at most 32 MiB; no network,
  signing, credentials, writes, deployment or provider execution.
- Uses the current UTC clock. Exit `1` means malformed/unreadable data, future
  generation, invalid interval, expired metadata or **72 hours or less** remaining.
  Exact expiry is failure. Exit `0` means only the timestamp diagnostic is healthy.
- `authenticated: false` is deliberate: this does **not** verify signatures,
  shape/contracts, feed availability, trust generation, monotonicity or provenance.
  A tampered timestamp can look healthy; never use the result as acquisition or
  publication authority. Independently authenticate fetched bytes with the reviewed
  Rust trust profile and domain-specific validator before recording a healthy feed.
- The template's `watch-registry-expiry.yml` is that read-only daily job: bounded
  HTTPS snapshot acquisition (no redirects/credentials), the diagnostic above and,
  where the released CLI has a verifier, signature verification. Missing feeds and
  verification failures fail the job. It has no secrets or write permissions; never
  attach signing or GitHub write tokens to monitoring. See the next section.
- Subscribe the actual alert destination to **all failed runs**, not only expiry
  warnings. Include run URL, feed namespace and remaining validity; exclude secrets.
  A separate watchdog must alert on a missing scheduled run within 24 hours.
  Escalate unacknowledged alerts to the backup owner; test delivery before launch.

No workflow/schedule or synthetic alert test here establishes live alert delivery.
Exercise expiry, corrupt signature, unavailable feed and missing-run alerts in an
isolated environment, and retain real acknowledgment evidence as an activation gate.

## Automatic catalog and policy renewal and expiry watch

Two workflows automate the routine part of the renewal runbook below. Both are
**template files, not yet deployed**: nothing renews or alerts until the registry
repository exists, the variables and environment below are configured by an
authorized operator, and a real alert path has been exercised.

| Workflow                        | Schedule           | Authority                                                                                                 |
| ------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `renew-protected-catalog`       | Daily, plus manual | Environment `protected-marketplace-renewal`; can only re-sign the catalog and renew the three policies    |
| `watch-registry-expiry`         | Daily, plus manual | `contents: read`, no environment, no secrets                                                              |
| `bootstrap-revocation-policies` | Manual only        | Reviewed environment `protected-marketplace-publisher`; publishes the three missing policies, empty, once |

**Renewal-only by construction.** `scripts/ci/registry-feeds.sh` downloads the
current published catalog from this repository's own discovery URL (HTTPS on
`raw.githubusercontent.com`, no redirects, bounded size) and writes a request with
`publications: []`, no inputs, no mirror tags and no schema upgrade. The pinned
released CLI authenticates that exact baseline against the pinned public key before
signing; a forged or stale download therefore fails closed. `publish` then re-asserts
the request before the CLI runs: only the fixed baseline/key/trust files may exist,
`publications` must be present and empty, no unknown fields, the repository must be
this one, and the window must stay within 14 days. Any deviation aborts before the
signing key is read by the CLI. The workflow has no `inputs`, and the reviewed
`publication-request.json` flow stays in `publish-protected-catalog.yml`.

**Cadence.** A new window lasts 13 days. The renewal runs daily but renews only when
the baseline has 8 days or less left (otherwise it logs a notice and succeeds), so a
healthy registry renews about every 5 days and keeps at least about 7 days of
validity. The daily schedule is also the retry policy: if a run fails, the next daily
runs try again, giving roughly five attempts before the daily watch fails at 72 hours
remaining. If every attempt fails, the owner must investigate, re-dispatch the
renewal or follow the manual runbook.

The renewal shares the `marketplace-publication` concurrency lane with the publisher
and never cancels a run, so the two can never race. The trade-off: GitHub keeps only
one _pending_ run per group, so a renewal that arrives while a dispatched publication
is queued behind a running job supersedes that pending publication, which must then
be re-dispatched. Separate groups would avoid this but would allow a renewal and a
publication to sign concurrently.

**Revocation policies.** After the catalog step, the same job renews each of the
three signed revocation policies (provider `managed-blocklist.json`, theme
`managed-theme-blocklist.json`, custom tab `managed-tab-blocklist.json`) whose
remaining validity is 8 days or less, each independently and with the same 13-day
window. The public CDN only schedules the renewal (it can lag the branch by about
five minutes). For each due policy the pinned released CLI runs
`registry fetch-policy` (the branch head through the authenticated GitHub API),
`registry renew-policy` and then `registry publish-policy --renewal`:

- `renew-policy` authenticates the fetched policy with the pinned public key
  (an already expired policy is accepted if, and only if, it is correctly signed),
  keeps its entries byte-for-byte identical, sets `generated_at` to now (it must be
  strictly newer) and a later `expires_at` inside the 14-day maximum, signs, and
  verifies the result again before writing it. It never reinterprets one domain as
  another: a provider policy has no `kind`, the theme and tab policies carry theirs.
  The signing call runs without the publication token in its environment.
- `publish-policy` verifies the candidate, requires the policy already on the
  discovery branch to authenticate and be strictly older (a rollback or a same-time
  replacement is refused), makes one conditional update of that single fixed path,
  and then reads the public raw URL back without credentials with the catalog's
  bounded convergence rules (at most six minutes, because raw.githubusercontent.com
  caches for up to 300 seconds; only the exact previous body may be waited out). The very first publication of a policy needs an explicit
  `--bootstrap`, which this workflow never passes: publish each policy once with
  `bootstrap-revocation-policies` (below) before enabling renewal. The workflow always passes
  `--renewal`: the entries on the branch at the moment of publication must be
  identical to the renewed ones, so a revocation an operator published after the
  baseline was read is never silently dropped; such a run fails and the next
  run renews from the new head.
- Policies are independent of the catalog and of each other: every stage of one
  runs even if a stage of the other failed (for example a 404 on an
  un-bootstrapped policy does not skip the catalog renewal), and any failure
  fails the run. A policy whose URL is not this repository's raw
  `refs/heads/<branch>/<policy file>` on the catalog's own discovery branch is an
  error, not a skip.
- The automation can only extend validity. Adding, changing or removing an entry is
  a reviewed, manual signing and `publish-policy` (see the revocation runbook).

The pinned released CLI in `ci/released-cli.env` must include `fetch-policy`,
`renew-policy`, `publish-policy --renewal` and `verify-provider-blocklist`; the
renewal step names the missing command and fails if it does not.

**Inert until configured.** If `CADENCR_REGISTRY_CATALOG_URL` is unset, each job
logs a notice and skips. Once it is set, any other missing required variable, any
download problem, any verification or renewal problem fails the run.

| Repository variable (public values)                                                                                     | Used by      | Meaning                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CADENCR_REGISTRY_CATALOG_URL`                                                                                          | both; switch | `https://raw.githubusercontent.com/<owner>/<repo>/refs/heads/<branch>/managed-index.json`; for renewal `<owner>/<repo>` must be this repository, and schema 2 requires branch `marketplace-v2`                       |
| `CADENCR_REGISTRY_KEY_ID`                                                                                               | both         | Active metadata signing key id                                                                                                                                                                                       |
| `CADENCR_REGISTRY_PUBLIC_KEY_PEM`                                                                                       | both         | SPKI PEM public key for that key; never a private key                                                                                                                                                                |
| `CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL`, `CADENCR_REGISTRY_THEME_BLOCKLIST_URL`, `CADENCR_REGISTRY_TAB_BLOCKLIST_URL` | both         | Public raw URLs of the three signed revocation policies; all required once the catalog URL is set. For renewal each must be this repository's `refs/heads/<branch>/<policy file>`, on the same branch as the catalog |
| `CADENCR_REGISTRY_TRUST_MANIFEST_JSON`, `CADENCR_REGISTRY_ROOT_KEY_ID`, `CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM`          | renewal      | Optional, all-or-none root trust profile passed as the request's `trust` object                                                                                                                                      |
| `CADENCR_REGISTRY_TRUST_MIN_GENERATION`                                                                                 | renewal      | Optional positive generation floor (default `1`)                                                                                                                                                                     |

| Environment / secret                                                | Where                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Environment `protected-marketplace-renewal`                         | Create it, restrict deployment to the default branch. Separate from the reviewed `protected-marketplace-publisher` |
| `CADENCR_REGISTRY_PRIVATE_KEY_PEM`, `CADENCR_REGISTRY_GITHUB_TOKEN` | Secrets of that environment only, same names and scopes as the publisher; read by the key and renewal steps only   |

The renewal environment holds a signing key that an unattended job can use. That is a
deliberate trade-off: protect the default branch and the workflow files with required
review, keep the token scoped to the registry repository, and note that the only
thing the key can do through this path is re-sign the authenticated baseline.

**What is not automated.**

- Revocation policy **entries** are never changed automatically: a renewal keeps them
  identical, and any addition, edit or removal is a reviewed payload signed with
  `sign-*-blocklist` and published with `publish-policy`. The first publication of
  each policy is a dispatched, reviewed run of `bootstrap-revocation-policies`, never
  part of the schedule.
- GitHub disables scheduled workflows in a public repository after 60 days without
  repository activity and emails only the person who last edited the cron line.
  Subscribe the real owner and backup to failed-run notifications and keep the
  independent missing-run watchdog above.
- Neither workflow proves live delivery: exercise a failing watch run and an
  acknowledged alert before relying on them.

## First catalog publication

The publisher never creates the discovery branch. Before the first
`publish-protected-catalog` run, create `marketplace-v2` from `main` (a branch
without `managed-index.json`); `previous_index: "bootstrap"` in the reviewed
request means only that this file is absent. If the run fails after the mirrors
and the catalog release are published, re-run the failed job of the same run:
it keeps the reviewed commit, request and window, reconciles the published
releases and then advances discovery.

## First publication of the revocation policies

The online signing key exists only as the secret `CADENCR_REGISTRY_PRIVATE_KEY_PEM`
of the GitHub environments, so no operator can sign the first publication of a
policy locally. The manual workflow `bootstrap-revocation-policies` does it, using
the same pinned released CLI and key handling as the reviewed publisher:

- **Gating.** Dispatch only from the default branch. A secret-free preflight job
  checks the input and the configuration first; the publishing job then waits for
  the required reviewers of environment `protected-marketplace-publisher` (not the
  renewal environment). It shares the `marketplace-publication` lane, never
  cancelled, with `contents: read` and an exact-commit checkout.
- **Input.** One required `confirm` input that must read exactly
  `bootstrap-empty-policies`. The repository variables `CADENCR_REGISTRY_KEY_ID`
  and `CADENCR_REGISTRY_PUBLIC_KEY_PEM` must be set; the three
  `CADENCR_REGISTRY_*_BLOCKLIST_URL` variables are optional here, but any that is
  set must be this repository's raw `refs/heads/marketplace-v2/<policy file>`.
- **What it publishes.** For each of provider, theme and custom tab, in that order:
  an empty policy (`entries: []`; the provider policy has no `kind`, the others
  carry theirs) with `generated_at` now and a 13-day window, the same horizon the
  renewal uses. The helper (`registry-feeds.sh bootstrap-policies`) signs it with
  `sign-*-blocklist` without the publication token in the signer's environment,
  checks it with `verify-*-blocklist` against the pinned public key, and runs
  `publish-policy --bootstrap`, which reads the public feed back (up to about six
  minutes per file, hence the 30-minute timeout).
- **Idempotent.** A policy that `fetch-policy` can already read from the branch is
  skipped with a notice, never re-signed or replaced, and `--bootstrap` itself
  refuses an existing policy. If a run fails after publishing only some policies,
  dispatch it again: it publishes just the missing ones.
- **Afterwards.** Set the three policy URL variables, then let the daily renewal
  and the expiry watch take over. Policy entries are still added only through the
  reviewed manual signing and `publish-policy` described below.

## Renewal runbook

The renewal workflow above performs steps 1–4 for the catalog and for each due
revocation policy (unchanged entries only), when configured; the manual procedure
remains the recovery path, the only path for policy entry changes, and the fallback
when a renewal run fails repeatedly. The first publication of each policy is the
dispatched `bootstrap-revocation-policies` workflow above.

1. Renewal owner authenticates and archives exact current catalog and both policy
   envelopes, trust generation, feed heads and immutable publication receipts.
   Investigate divergence/unavailable bytes; never pick an unsigned alternate baseline.
2. Plan renewal before the 72-hour warning; create strictly newer whole-second UTC
   generations within each contract's validity bounds. The catalog's maximum
   publication window is 14 days. Catalog renewal uses an authenticated baseline
   and `publications: []`: no historical package rebuild/download or release mutation.
3. Review the exact request/commit and policy payloads in the protected environment.
   Never extend timestamps without new signatures. Renew policies independently
   (`registry renew-policy --kind provider|theme|tab`); a fresh catalog cannot extend
   any revocation policy's validity.
4. After explicit publication authority, use the qualified Rust pipeline and local
   policy signing/verification/renewal/publication commands in
   [release configuration](../../docs/MARKETPLACE_RELEASE_CONFIG.md).
   Preserve exact content-bound state after any error; reconcile the same operation
   rather than retrying new writes or rolling back. A failed final verification can
   leave remote state advanced without a success receipt.
5. Independently fetch public bytes without credentials; authenticate all namespaces,
   confirm high-water continuity and expiry, then verify a supported packaged client.
   Retain run/receipt evidence and acknowledge/clear alerts only after these checks.

### Source-only discovery convergence correction

This historical heading is retained for existing links. The correction is now
included in qualified `0.15.2`; it is no longer source-only.
A deterministic regression reproduces the failure class: after discovery advances, its stable
public URL serves the exact previous signed catalog before serving the candidate.
This does not establish which response caused the historical hosted error.

- Keep the canonical stable discovery URL and request cache revalidation; a
  commit-pinned alternate URL is not proof that the configured feed is current.
- Allow the public reads a shared convergence window, including inter-read
  authenticated head checks and backoff. The window is 30 seconds for the
  authenticated API read-back but six minutes (360 s; pauses of 1 s doubling to
  8 s, at most 45 reads) for the public stable URL, because
  raw.githubusercontent.com answers `Cache-Control: max-age=300` and may keep
  serving the previous body for five minutes after the write. Each HTTP request
  receives only the remaining budget, including response-body reads. This is not
  a bound on the complete publication command or its other validations; a
  renewal publishing the catalog and three policies may spend about six minutes
  per file waiting, so the workflow jobs allow 60 (renewal) and 45 (publisher)
  minutes.
- Only fully read bytes matching the reviewed predecessor's exact SHA-256 may
  trigger another read. Bootstrap has no predecessor allowance. The observation
  remains bounded by the discovery size limit; only the exact candidate size and
  SHA-256 can produce success.
- Unknown content, invalid/truncated/oversized responses, redirects, transport or
  cleanup errors remain terminal. Recheck authenticated candidate identity and
  freshness before additional reads; retain the final release/tag/asset checks.
- Never repeat publication mutations, CAS, or the whole pipeline automatically.
  Persistent predecessor bytes exhaust the budget without a success receipt.
  Preserve the original operation after failure, as required by step 4 above.

Merge, green CI, CLI-only release and exact distributed-binary qualification
are recorded in the October 21 evidence, including first-pass renewal, same-intent
replay and clean-runner recovery. Production adoption still requires separately
approved delivery. A separately reviewed new operation
may follow a reconciled prior operation; if an attempt fails, preserve its exact
request, commit and timestamps rather than replacing them to manufacture success.

## Revocation incident runbook

1. Incident owner records report, affected identity/version/digest, namespace and
   evidence. Decide whether to block an entire identity, version range or digest;
   automation does not make that judgment. Preserve forensic evidence and receipts.
2. Prepare a new reviewed policy with a visible reason and strictly newer generation.
   Theme policy is domain-bound `kind: "theme-blocklist"`; never reinterpret a
   provider policy as a theme policy. Sign and independently verify exact bytes.
3. Authorized publisher advances only the intended policy feed, then verifies public
   bytes and a packaged client: matching content fails closed, removal remains
   possible. Do not disable verification to mitigate a missing/expired policy.
4. Notify security contact and affected users; retain incident timeline and ownership.
   Reversing a revocation is a new reviewed policy generation, not deletion of history.

## Key rotation and compromise

- Ordinary delegated-key rotation: independently provision B; offline root signs a
  strictly higher trust generation retaining A only with a fixed retirement cutoff.
  Deliver reviewed trust/root pins to supported apps **before** B-signed feeds.
  Exercise historical A receipts/cache → B continuity; old apps are not retrofitted.
- Compromise: incident owner suspends affected publication access, preserves evidence,
  removes A and includes it in `revoked_key_ids`. Do not retain a compromised key as
  historical authority. Root-authorized exact canonical-envelope recovery checkpoints
  are namespace-specific baselines only, never current metadata/receipt authority.
- Re-sign successors with independent B, authenticate every public namespace, and
  verify packaged-client fail-closed and recovery behavior. Unknown cache history
  requires reviewed recovery, never database/cache deletion or unapproved rollback.
- Offline-root compromise/replacement requires an independently reviewed app-delivery
  incident. Publication automation cannot replace its own root of trust.

See [trust-generation procedures](../../docs/MARKETPLACE_RELEASE_CONFIG.md#root-authorized-trust-generations)
for exact manifests and command syntax. A local fixture drill is not production key
rotation, revocation delivery or deployed monitoring evidence.

## Optional LSP policy rollout

After qualifying a CLI release that supports LSP packages and policies, configure
`CADENCR_REGISTRY_LSP_BLOCKLIST_URL` with this repository's canonical
`refs/heads/<catalog-branch>/managed-lsp-blocklist.json` URL. The template's
bootstrap, renewal and expiry-watch workflows then include the independent
`lsp-blocklist` policy. Leaving the variable unset keeps existing three-policy
deployments working. Bootstrap remains an explicit operator action; setting the
URL alone does not create a policy or publish packages.

The desktop build's separate `CADENCR_MANAGED_LSP_BLOCKLIST_URL` must point to
that verified policy before marketplace LSP installation is enabled. Publish
real prepared native or Node assets and reviewed package metadata as described
in the [LSP authoring examples](examples/lsp/README.md). The example metadata
contains placeholders and is not a migration of the former bundled catalog.
