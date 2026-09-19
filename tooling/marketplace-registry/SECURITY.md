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
