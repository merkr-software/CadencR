# Registry Security Policy

## Reporting

Before deploying this template, repository owners must replace this paragraph
with a monitored private security contact or GitHub private vulnerability
reporting instructions. Do not invent or publish an unmonitored address.

Include the provider ID/version, affected digests, source revision, impact, and
safe reproduction details. Do not attach credentials or exploit public users.

## Maintainer response

Maintainers should preserve evidence, verify artifact identity, coordinate with
the publisher, and decide independently whether to stop discovery and whether to
revoke execution through the signed blocklist. Signing-key compromise requires
the product trust-root recovery process; publishing a newly signed index alone
cannot replace a compiled trust root.

## CI trust boundary

The metadata contribution gate runs the validator from the trusted base commit
against a separate candidate checkout treated only as data. It does not execute
candidate scripts, install dependencies or download provider archives. The job
uses ordinary `pull_request`, read-only repository permissions and no signing
secrets. See [GitHub's trigger security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

Install the validator and workflow on the reviewed default branch before accepting
contributions. This is a standalone registry template; copying only the workflow
without its scripts/schema does not bootstrap a functioning gate.
During bootstrap, remove the demonstration package before establishing the first
accepted registry baseline; `example.invalid` metadata is not a real contribution.
An empty `packages/` directory must exist for local snapshot checks (Git does not
preserve empty directories; a `.gitkeep` may be used). Once contributions are
accepted, normal PR checks deliberately forbid version deletion.

A PR can propose changes to the workflow itself. Therefore a green PR check is
not a publisher authorization or proof that the proposed validator is trustworthy.
Require maintainer review of workflow/tooling changes and configure repository
protections before deployment. Tests of PR tooling remain in an unprivileged job,
isolated from signing and publication credentials. The template's
separate tooling-test job deliberately runs candidate tests as untrusted code on
a disposable hosted runner, without persisted checkout credentials, secrets or
write permissions. It does not supply artifacts or authority to the metadata gate
or protected publisher. Do not convert that job to a privileged trigger.

Protected publisher jobs must independently revalidate reviewed default-branch
metadata inside a protected publication environment. They must not invoke package
executables or contributor-controlled build scripts. Those jobs and repository
protections are not provisioned by this local template.

## Local signing and mirror plans

The local planner and signer are separate primitives, not a protected publisher.
A mirror plan records intended destinations, not observed remote availability.
The signer checks payload shape/time bounds and its own Ed25519 signature; it does
not authorize a publisher, verify source builds, pin a public key in Cadencr, or
confirm remote asset digests. A key ID alone does not establish trust: deployment
must match the private key's public half to an explicitly configured host trust root.

Run local tests with generated disposable keys only. Never commit private keys,
pass them in command arguments, or expose them to PR tooling/provider executables.
Production key provisioning, rotation and environment protections remain separate
operator decisions. The existing workflow still stops before signing and releases.

## Archive transfer boundary

Local staging follows redirects manually because GitHub asset downloads can
redirect ([GitHub release asset API](https://docs.github.com/en/rest/releases/assets)).
The transfer policy allows only HTTPS on `github.com`,
`release-assets.githubusercontent.com`, and `objects.githubusercontent.com`, without
custom ports, URL userinfo, wildcard domains or arbitrary redirect destinations.
This allowlist is a conservative policy, not a promise covering every future
GitHub CDN change. Unexpected destinations fail closed. System DNS and TLS remain
trusted; do not run the publisher in a hostile network or filesystem environment.

Transfer code sends no GitHub token or cookies and rejects non-identity HTTP
content encoding to preserve the submitted archive bytes. Redirect query strings
must never be included in diagnostics. Local digests certify received bytes only:
maintainer authorization, source/tag provenance, remote mirrored-asset verification,
protected signing and publication are still separate mandatory gates.

## Draft mirroring credentials and remote state

`mirror:publication` is an explicitly mutating operator command. Its dedicated
`CADENCR_REGISTRY_GITHUB_TOKEN` must be scoped to the selected repository's release
operations and supplied only from a protected environment. Do not pass it in argv,
store it in the submission/receipt, or give it to contributor code. The CLI has no
API-host override and requires matching `--repository`/`--confirm-repository` plus
an exact registry commit. These guards prevent accidental invocation, not malicious
use of an already-authorized token.

The client uses fixed GitHub API/upload origins, rejects API redirects, bounds
responses and streams uploads. Asset verification uses the API token for the first
asset request only; the existing downloader enforces the uncredentialed CDN
redirect policy. Error responses and redirect query strings are not logged.

[GitHub release APIs](https://docs.github.com/en/rest/releases/releases) distinguish
drafts from published releases. This command creates drafts only and never promotes
a release or changes catalog discovery. [Asset uploads](https://docs.github.com/en/rest/releases/assets)
can leave incomplete state after failures; this tool reconciles and verifies rather
than deleting/replacing uncertain assets. Human recovery of conflicts remains
explicit, and workflow concurrency/protected production publication is not installed.

## Promotion boundary

`promote:publication` is a separate explicit publishing command, not an automatic
continuation of mirroring. A dedicated token and exact repository/tag confirmations
are required. Protected environment approval and cross-runner serialization are
operator responsibilities; this increment does not deploy a workflow or provision
repository protections.

The [release API](https://docs.github.com/en/rest/releases/releases) does not use
`target_commitish` to move an existing tag. Promotion therefore resolves the actual
Git reference and bounded annotated-tag chain before and after publication. A
missing, ambiguous or conflicting tag fails closed; no tag is created or updated.
This detects inconsistencies but cannot prevent an external writer racing between
checks. Configure tag protections and release immutability before production use.

The post-publication transfer uses the ordinary unauthenticated downloader, not the
private asset API bridge. A private repository or unavailable public URL cannot
produce a new publication receipt. A failed verification can leave a published
release: recovery is verification/retry, never automatic deletion or unpublishing.
No signing key is read and catalog/discovery remains untouched. A receipt does not
prove publisher ownership, reproducible builds, permanent immutability or ongoing
availability; protected catalog publication still needs its own checks.

## Catalogue signing gate

`sign:publication-catalog` does not read GitHub tokens or publish remotely. The
manifest and staged receipts are trusted operator inputs, never a PR artifact
handoff. It validates all included packages and publication bindings, verifies
public archive/provenance bytes, then loads the signing key. It does not execute
provider code, import contributor modules, extract archives or interpret receipt
fields as commands.

Protect the tooling revision, key path, manifest and workspace. Receipts can be
forged by a writer with access to that workspace; they do not establish human
approval, source ownership or build provenance. Fresh download checks prove
availability and matching bytes only at verification time, not permanent hosting.
Repository/tag protections and immutable releases remain required operational gates.

The low-level `sign:index` helper remains available for trusted operators and is
not a replacement for this publication gate. Neither command provisions a protected
signing environment. The bootstrap preparation workflow remains unsigned and must
not be mistaken for the production publishing workflow. Actual catalogue upload,
anti-replay/history reconciliation, distributed serialization and discovery changes
are intentionally not performed by this local signing increment.

## Signed snapshot publication boundary

`publish:catalog` verifies signatures with an operator-pinned public key, validates
history against an explicitly supplied baseline, and rebuilds the payload through
the existing publication-evidence/public-download gate before release writes. It
never loads a private key. Candidate and baseline inputs are limited to 1 MiB, the
same limit currently enforced by app catalogue acquisition.

The historical baseline may be expired, but must remain correctly signed with
canonical valid metadata. Candidate freshness and strictly increasing publication
time are required. Removing/changing a previously accepted version is rejected;
delisting and revocation require their own reviewed policy, not silent omission.
A supplied baseline does not prove the globally latest revision: the future
discovery updater must use authoritative state and a concurrency guard. Explicit
`bootstrap` must be approved operationally and is not a remote-empty-state check.

The release name/tag and body bind canonical snapshot bytes, registry commit and
previous snapshot digest. The public asset is independently re-downloaded without
authentication. Receipt files remain historical local evidence. Repository release
immutability, tag protections, required reviewers and distributed serialization
are not provisioned by this command. As with provider promotion, a failure after
publication does not authorize rollback or deletion. No `latest` or discovery
location is mutated, preserving the currently advertised catalogue.

## Stable discovery and concurrency boundary

Discovery stores the complete signed index at a fixed file on an explicitly
configured existing branch. Consumers retain their existing signature/freshness
checks; there is no new unsigned pointer format. The public verification transport
permits only the configured raw GitHub path and does not forward API credentials.
The archive transport retains its separate release/CDN policy.

The [Contents API](https://docs.github.com/en/rest/repos/contents) requires the old
blob SHA for updates. Because Contents may dereference symlinks, the publisher first
checks the root entry mode through the commit-pinned
[Git tree](https://docs.github.com/en/rest/git/trees#get-a-tree), rejecting symlinks,
submodules and truncated responses. Contents reads use that immutable commit.
The publisher validates decoded bytes and their Git blob hash,
checks the signed baseline against this observed head, and performs one conditional
update. Lost responses are reconciled, never blindly retried with a newer SHA.
This detects competing different-file updates but cannot prevent privileged
external rollback/deletion or a later change after verification. Protect branch
writers and retain app-side high-water marks; do not claim a distributed transaction.

A discovery receipt is historical evidence only. After a committed update,
public-cache lag or verification failure does not authorize reverting to an old
catalogue. Retry the same candidate or investigate; do not overwrite newer state.
Dedicated token scope, protected environment approval and repository policies are
operator responsibilities. The unsigned preparation workflow has default-branch,
exact-revision and concurrency guards, but it is not the fully wired privileged
publisher and does not install environment reviewers or branch rules.

## Protected pipeline trust boundary

The pipeline request and all referenced inputs must come from a reviewed, immutable
registry checkout. The explicit request SHA-256, repository and commit bind the
operator intent; a request digest alone cannot attest mutable referenced files.
The private Ed25519 key must match the pinned public key before publication starts.
Unsigned preflight must reject invalid dates, baselines, identities and paths before
remote writes. Signing remains gated on verified public provider assets/provenance.

Only missing, namespace-constrained publication tags may be created. Existing tag
conflicts are fatal, including races; no tag update/delete operation is exposed.
As elsewhere, partial remote success is preserved for investigation and replay,
not rolled back. Local pipeline locking is not a cross-machine transaction. Remote conflicts can
occur after earlier provider publications; preflight covers local inputs, not an
atomic reservation of every remote name. The signing/discovery gates prevent a
partially completed provider set from being newly advertised by this invocation.
The CLI rejects a private-key target inside state; nevertheless, operators must
keep unrelated secrets out of that directory before any artifact upload.

The hosted template is manual/default-branch only, uses the exact dispatch commit,
and gates credential access through an externally configured protected environment.
The default `GITHUB_TOKEN` has read-only contents permission; the dedicated publish
token and signing key are confined to their respective steps. Recovery artifacts
must never contain a private key and are not a trusted code source. Automatic state
hydration or arbitrary run-artifact restoration is deliberately absent; do not
claim fresh-runner or subsequent-request recovery until that boundary is implemented
and verified. No live GitHub deployment or production key validation is implied by
local fixture tests.
