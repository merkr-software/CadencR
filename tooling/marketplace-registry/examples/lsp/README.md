# Prepare a language-server release

These source examples use placeholder repository URLs, lengths and digests. They
are authoring templates, not published packages. Use the CLI built from this
checkout; adopting or publishing that CLI is a separate release operation.

## Distribution contract

| Runtime  | Archive contents                                                                                | Prerequisite                    |
| -------- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| `native` | One native executable at `entry`, mode `0755`                                                   | Exact platform and architecture |
| `node`   | Prepared `.js`, `.cjs` or `.mjs` entry and every dependency, regular files normalized to `0644` | Existing Node executable        |

The host launches the entry directly or with Node. It never runs shell install
recipes, package scripts, `npm install`, or dependency resolution. Build and test
upstream language servers outside Cadencr packaging. Native scripts are refused.
The executable format and architecture are checked for each supported target
(`darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`). macOS arm64 binaries must be
signed. Do not declare targets you have not built and tested.

## Package a native server

Prepare a dedicated tree containing the built upstream executable:

```text
staging-native/
  bin/server
```

```bash
cadencr registry pack-lsp \
  --directory /absolute/staging-native \
  --target linux-x86_64 --runtime native --entry bin/server \
  --output /absolute/artifacts/lsp-linux-x86_64.tar.gz
```

## Package a Node bundle

Prepare compiled JavaScript and dependencies before packaging. Omit development
files, credentials, symlinks (including package-manager shim links) and `.bin`.
Use the upstream package's real JavaScript entry with signed arguments.

```text
staging-node/
  dist/server.js
  node_modules/dependency/index.js
  node_modules/dependency/package.json
```

```bash
cadencr registry pack-lsp \
  --directory /absolute/staging-node \
  --target linux-x86_64 --runtime node --entry dist/server.js \
  --output /absolute/artifacts/lsp-linux-x86_64.tar.gz
```

The output parent must exist, outside staging. Existing output paths are refused.
Packaging is deterministic and executes nothing. Copy `sha256`, `size`, `entry`,
`entry_sha256`, `entry_size` and `runtime` from its JSON receipt into the target in
`package.native.json` or `package.node.json`; replace the URL with the exact
planned GitHub release asset. Hashes cover the compressed archive and launch
entry separately. Limits: 64 MiB compressed, 256 MiB expanded, 4096 Node files.

## Metadata and plugin members

`languages` maps each LSP language ID to its own literal extensions (without a
leading dot) and exact filenames. This preserves TypeScript versus TSX mapping.
`role` is `type_checker`, `linter`, `formatter` or `general`. Root markers are
literal basenames. Arguments are passed unchanged without shell expansion.
`initialization_options` is an object bounded to 64 KiB. Compatibility uses the
standard signed `host.compatibility` fields.

A plugin's signed `contributes` array may contain the complete `kind: "lsp"`
envelope. Members share the plugin's version, repository, publisher and
compatibility. A local `plugin.json` member uses `{"kind":"lsp","path":"lsp"}`;
the member folder holds its complete signed package as `lsp.json`. Standalone
validation is `cadencr plugin validate /absolute/member --kind lsp`.

Use `submission.node.json` as the schema-2 submission template after replacing
its placeholders. Source commit, repository and tag must identify the same
release as every target. Existing `plan-publication`, `stage-publication`, mirror,
restore and catalog signing commands support standalone and plugin LSP members.
No remote publication is performed by these examples.

## Revocation and rollout

The independent signed policy is `kind: "lsp-blocklist"`, at
`managed-lsp-blocklist.json`. Entries use `lsp_id`, optional
`version_requirement`, `archive_sha256`, `entry_sha256`, and a required reason.
The CLI provides `sign-lsp-blocklist`, `verify-lsp-blocklist`, and existing policy
renewal/publication with `--kind lsp`. Refresh the example dates before use.
Revoked signing keys and scoped offline-root recovery checkpoints use
`recovery_lsp_policy_sha256`; a checkpoint authenticates history, not current
policy authority.

Before deployment, publish and verify real initial LSP packages plus this policy
on the registry's existing mixed catalog branch. Removing the compiled catalog
is a source change; these examples do not migrate or remotely publish the former
17 built-in entries. Initial real package publication is an external delivery
requirement before rollout. Existing installed legacy servers remain a migration
input; they are not evidence that a marketplace package has been published.
