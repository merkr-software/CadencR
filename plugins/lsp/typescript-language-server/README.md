# TypeScript language server package 0.1.0

This package prepares TypeScript and JavaScript language intelligence for
Cadencr **0.16.1 or newer**. It requires an existing **Node.js >=20** executable;
the qualified runtime is **Node.js 22.19.0**. Installation and launch never run
npm, package-manager shims, dependency resolution or lifecycle scripts.

## Source and payload

| Component | Version | Upstream commit | License |
| --- | --- | --- | --- |
| [TypeScript language server](https://github.com/typescript-language-server/typescript-language-server) | 5.3.0 | `589044479e4bc2bffb796b593242136f5323b582` | Apache-2.0; copied Microsoft code retains its MIT notice |
| [TypeScript](https://github.com/microsoft/TypeScript) | 6.0.3 | `050880ce59e30b356b686bd3144efe24f875ebc8` | Apache-2.0 |

`payload/source-lock.json` uses the key `sources` and records both exact official
npm tarball URLs, their byte sizes, npm SHA512 integrity and SHA256, upstream
commits, and every extracted file's path, size and SHA256. No `latest` tag is
resolved. The full distributions contain **145 regular files**, totaling
**26,682,278 bytes**, including TypeScript's runtime libraries and notices.

`payload/bundle.tar.gz` is the canonical prepared Git blob used for all three
targets: `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64`. Its entry is the real
JavaScript module `lib/cli.mjs`; arguments are `--stdio`. TypeScript is included
under `node_modules/typescript`. Automatic typing acquisition is disabled.

| File | Bytes | SHA256 |
| --- | --- | --- |
| `payload/bundle.tar.gz` | 5,014,231 | `295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286` |
| `payload/source-lock.json` | 20,846 | `dfd04ebc92a461bf968e65bdc78d421a956dec7dfce655d17531c5518769f387` |
| `package-template.json` | 3,149 | `cea23ecd78255d6afc313b737ec16704f4ccbfc028625147a8582bfaa40b7b26` |
| Launch entry `lib/cli.mjs` | 890,213 | `86ef128358dcd71d0c684d786d7751ee09fbbbbb2a521482b160007b8228be2e` |

Every archive member is a regular file with mode `0644`, uid/gid/mtime zero,
without symlinks or hardlinks. The payload preserves upstream `LICENSE`,
`node_modules/typescript/LICENSE.txt` and
`node_modules/typescript/ThirdPartyNoticeText.txt` verbatim.

## Reproduction and trusted preparation

The immutable [QA recipe at commit 6d651cb](https://github.com/merkr-software/cadencr-registry-qa/tree/6d651cbff4f0fe154e68e7c05875f4d2f2cba318/scripts/lsp-node-seed)
reproduces the locked npm extraction and canonical archives. It verifies both
tarballs and all extracted files, then packs twice per target using the released
Linux x86_64 CLI **0.15.5**, SHA256
`b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441`.
Use this exact ELF for compressed-byte reproduction; a source-built macOS CLI
produced different compressed bytes despite an identical uncompressed tar.

The primary protected pipeline consumes committed Git blobs only. It verifies and extracts this prepared archive into isolated
scratch, checks the locked inventory, and calls the trusted Rust packer twice
per target. Keep the lock, manifest and this README outside the extracted
145-file bundle. The underlying canonical command is:

```sh
cadencr registry pack-lsp \
  --directory /absolute/verified-bundle \
  --target linux-x86_64 --runtime node --entry lib/cli.mjs \
  --output /absolute/new-artifacts/lsp-typescript-language-server-0.1.0-linux-x86_64.tar.gz
```

Use each of the three target names and compare both outputs with the qualified
digest above. The primary orchestrator runs within
the existing trusted main publication context:

```sh
sh scripts/official-plugin-release.sh --author-approved \
  "$SOURCE_REPO" "$SOURCE_COMMIT" \
  lsp-typescript-language-server-v0.1.0 "$NEW_OUTPUT"
```

`SOURCE_COMMIT` must be the actual reviewed primary Git commit containing this
source snapshot, and the existing release tag must resolve to that commit. No
primary source commit is invented or copied from the QA repository.

## Qualification and publication scope

[QA run 41727012894](https://github.com/merkr-software/cadencr-registry-qa/actions/runs/41727012894)
qualified these exact archive bytes on Ubuntu 24.04.5/x86_64, macOS
15.8.2/arm64 and macOS 15.7.9/Intel x86_64, using Node.js 22.19.0. Checks covered
initialization, bundled TypeScript 6.0.3 selection, semantic diagnostic TS2322,
hover and graceful shutdown. The Mac jobs consumed the Ubuntu job's same-run
artifact and verified active deny-network sandboxing. These are runtime
qualification results, not publication authority or Cadencr app-install/UI,
revocation, or minimum-macOS-version qualification.

**PUBLICATION ONLY:** the intended GitHub package tag is
`lsp-typescript-language-server-v0.1.0`. The manifest keeps
`min_app_version: 0.16.1`. This package release does not add entries to the
production catalogue, activate production feeds, or release the desktop app.
