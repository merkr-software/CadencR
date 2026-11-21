# Official plugin release flow

Use this flow from an app release. Official plugins maintained in this repository
have independent versions and GitHub release tags. Users install the packages
through the signed marketplace catalog. Follow the existing
[plugin release runbook](../../../plugins/RELEASING.md) for publication policy.

## P1. Detect and propose

- Use the intended app source from step 2 to discover candidates. Inspect Cursor
  and Antigravity in `plugins/providers/` and the official entries with a supported
  release path in `plugins/release-policy.json`. Read each package template for
  its version and `package.host.compatibility.min_app_version`. An entry with
  `preparation: READY` still needs the applicable publication policy and approvals.
- Reuse the fetched tags and a single paginated GitHub release inventory.
  Native providers, themes and tabs use `plugins/<kind>-<id>/v<version>`.
  Allowlisted LSP packages use `lsp-<id>-v<version>` as defined in
  `scripts/official_plugin_tags.py`. Verify the candidate tags and their expected
  release assets with `gh release view <tag> --json isDraft,isPrerelease,assets,url`.
  Treat API failures as an unknown status until resolved.
- Compare the intended package with the tagged source, even when the tag predates
  the app release range. Inspect shipped code and assets, native build inputs
  and relevant shared SDK or lockfile changes, or the policy's mapped inputs
  for tracked payloads. Use the current version for an untagged first release
  or update when it is higher than any prior version. If the intended package
  changed since its current version was tagged, propose a new version using
  the [semver guidance](SKILL.md#t2-propose-the-versions).
- Resume an unpublished tag or a matching draft from the exact tagged source
  when it matches the intended package. For tracked payloads, the tagged
  `plugins/release-policy.json` must also match the trusted `main` policy
  byte for byte. If that check fails, report the blocker and propose a new
  version from reviewed source. Preserve existing tags and assets. Report
  a conflicting published release for review and use a new version if needed.
- Present one table at app step 5 with plugin id, last published version, proposed
  version, minimum compatible app and reason or blocker. Let the developer
  select each plugin independently. Flag any minimum app version above the app
  being released and any package required at app launch. Use the signed catalog
  to identify already published packages awaiting admission. Resume those at P5.

## P2. Prepare confirmed versions

- For native providers, keep the plugin's `Cargo.toml`, `package.json`,
  `package-template.json`, `readiness.json` and root `Cargo.lock` consistent.
  Review the provider release notes in `scripts/native_provider_release_prepare.py`
  and run the [plugin checks](../../../plugins/README.md#separate-commands).
  For tracked payloads, follow the runbook to update the package template and
  its version and source bindings in the release policy. Keep minimum compatibility
  aligned with the first app that supports the package. Include these edits in
  the app release preparation commit.

## P3. Bind the source and qualify

- Fetch `origin/main` before preparing the selected plugins. Verify each
  reviewed source commit is on it and push new plugin tags at those commits.
  When resuming, verify the existing upstream tag resolves to the reviewed
  source commit before continuing.
- For Cursor and Antigravity, follow the runbook's
  [compiled provider path](../../../plugins/RELEASING.md#compiled-providers)
  and record the successful native build run for the exact source and provider.
- For tracked theme, tab or provider payloads, wait for
  `official-plugin-release.yml` to prepare the source-bound candidate where
  the workflow handles that tag. For an allowlisted LSP tag, follow the
  runbook's pinned preparation and protected inspection path.

## P4. Inspect and publish

- Run the inspection-only dispatch from `main` per the
  [native](../../../plugins/RELEASING.md#compiled-providers) or
  [tracked](../../../plugins/RELEASING.md#protected-manual-author-workflow)
  author procedure. Review the request digest, tag and source binding, exact
  assets and metadata. Retain `package.json` and `submission.json` from the
  verified inspection for P5.
- Present the inspection URL and digest. Obtain explicit confirmation for
  each plugin and version before dispatching the inspected request. Share the
  publish run URL for the existing protected environment approval. Both author
  workflows share a concurrency group. Wait for the current author run to finish
  before dispatching another and continue other independent release checks while
  approval is pending. Verify the published release and expected assets.

## P5. Submit and verify marketplace availability

- Open the matching package and submission through the
  [registry contribution flow](../../../tooling/marketplace-registry/README.md#contributor-path).
  Verify the inspection metadata against the published `package.json` and
  archives. For a release being resumed, recover its matching inspection
  artifact. If it expired, reconstruct the submission from the published
  package, verified tag and commit, and reviewed release notes, then validate
  it with the registry's pinned CLI.
- Follow [registry operations](../../../tooling/marketplace-registry/OPERATIONS.md)
  for review, signing and any channel-specific rollout requirements. Verify
  the exact version in the signed catalog and run the plugin's documented
  managed install and runtime checks on compatible app builds. Until then,
  report the source release URL and pending registry or verification step.
