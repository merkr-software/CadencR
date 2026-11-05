# Native LSP candidate preparation

These recipes are review candidates. They do not authorize publication, app release,
or production catalog activation. Every member requires app `0.16.1` or later.

## Reviewed baselines

| Member | Upstream version | Runtime data / external toolchain |
| --- | --- | --- |
| rust-analyzer | 2026-11-02 | Rust toolchain, cargo and rust-src for project analysis |
| Gopls | 0.24.0 | Source-built with Go 1.27.3; Go required for project analysis |
| TypeScript native preview | 7.0.0-dev.20260707.2 | Bundled TypeScript standard declaration libraries |
| Biome | 2.6.5 | Local Unix socket daemon; isolated smoke stops its own daemon |
| Oxlint | 1.91.0 | Native language server |
| Ruff | 0.17.3 | Native Python linting/formatting server |
| LuaLS | 3.19.2 | Bundled Lua scripts, locale and metadata files |
| Clangd | 23.1.0 | Bundled Clang resource headers; project compiler/SDK required |
| Terraform LS | 0.39.1 | Terraform CLI needed for provider schema discovery |
| Taplo | 0.10.0 | Remote schema catalogs disabled in qualification |
| Marksman | 2026-02-08 | `.marksman.toml` marks the multi-file hover fixture |

`plugins/lsp/native-recipes/*.json` pins official source URLs, source SHA-256 and
sizes, selected executable SHA-256 and sizes, licenses, language associations,
launch arguments and external toolchain requirements. Acquisition never invokes
npm, uv, installers, package scripts or an acquired server.

## Prepare and canonically pack

```sh
python3 scripts/lsp-native-prepare/prepare.py \
  --recipe plugins/lsp/native-recipes/ruff.json --target linux-x86_64 \
  --cache /tmp/lsp-cache --output /tmp/lsp-ruff-linux

# Run on the canonical Ubuntu x86_64 host with the qualified released CLI.
cadencr registry pack-lsp --directory /tmp/lsp-ruff-linux/runtime \
  --target linux-x86_64 --entry ruff --runtime native \
  --output /tmp/lsp-ruff-linux/bundle.tar.gz
```

Each result contains `runtime/` and a schema-2 `source-lock.json`. The lock inventory
includes exactly the retained files, their hashes, lengths and normalized modes:
selected executable `100755`, other files `100644`. Include complete runtime data
and license notices. Pack with the released CLI supporting native readable data;
CLI 0.15.5 emits only the entry and is unsuitable for these trees.

`--offline` refuses missing source archives, toolchain archives and Go modules.
The official Go archives for Linux x86_64, macOS ARM and macOS Intel have separate
pinned full SHA-256 values. Go's dependency graph is frozen by module version and
`h1` content checksum; the final executable must also reproduce its target hash.
No environment credentials enter the source build.

Clangd Linux additionally requires `--strip-program /usr/bin/strip` using GNU
binutils 2.42. The reviewed `--strip-debug` transform reduces its executable from
148,913,784 to 75,660,208 bytes, retaining functionality. macOS uses the exact CPU
slice of the official universal Mach-O rather than carrying the other CPU slice.
Result hashes bind both transformations. Retain Clang resource headers and the
LLVM license; omit compiler runtime object files unnecessary for language service.
Upstream archives are inspected in memory under download, member count and expanded
size budgets; only audited regular files are written. Links, unsafe paths,
duplicate destinations and native executable companions are rejected.

## Protocol and semantic qualification

```sh
python3 scripts/lsp-native-prepare/smoke.py \
  --entry /tmp/lsp-ruff-linux/runtime/ruff --args-json '["server"]'

python3 scripts/lsp-native-prepare/native_semantic.py \
  --recipe plugins/lsp/native-recipes/ruff.json \
  --bundle /tmp/lsp-ruff-linux/runtime --target linux-x86_64 \
  --output /tmp/ruff-semantic.json

python3 -m unittest discover -s scripts/lsp-native-prepare -p 'test_*.py'
```

For Gopls semantic checks, provide `--toolchain-path /verified/go/bin` with Go 1.27.3.
Use the target matching the actual machine architecture. Run Linux qualification
in a container with `--network none`; macOS uses `sandbox-exec` to deny remote
networking while permitting local Unix-domain IPC. All candidate processes receive
only an explicit minimal environment with a private HOME/cache/temp tree. Go module
and toolchain downloads are disabled in semantic probes.

Semantic probes verify real lint/diagnostics, link hover, function hover, or document
symbols, then exercise shutdown and successful exit. They support indexing retries,
server configuration requests and watcher capability registration. This protocol
client does not prove the application's own LSP client supports every capability;
verify app integration separately, particularly TypeScript native preview watcher
registration and client diagnostic refresh requests.

## Validation recorded during preparation

All eleven macOS ARM candidates passed real semantic probes with remote networking
denied. All three platform executables were acquired and architecture-checked;
Gopls was source-built and its macOS ARM build reproduced via the uniform preparer.
Linux and macOS Intel runtime results require their own matrix evidence; an ARM
result does not establish behavior on either other target. Nine acquisition tests
cover unsafe paths, links, duplicates, native companions, size budgets, architecture
mismatches, universal slice bounds and source pin requirements.

## Backend watcher qualification

The production proxy implements dynamic file watching for the workspace and its
pinned managed runtime. Unsupported ancestor-wide requests receive an explicit
JSON-RPC error; they are never silently acknowledged. Native setup and runtime
watch failures remain visible to the user. macOS aliases are matched by filesystem
identity and existing registration IDs are atomically replaced.

```sh
CADENCR_TEST_TSGO_BIN=/path/to/verified/runtime/lib/tsgo \
  pnpm --config.verify-deps-before-run=false rust -- test -p cadencr-service \
  real_tsgo_import_create_edit_delete_flows_through_proxy_watchers --lib
```

This opt-in test verifies the executable against the reviewed recipe, clears the
child environment, then drives the production stdio proxy and filesystem watcher.
A missing import reports TS2307, creating its dependency clears the error, editing
the dependency reports TS2322, and deleting it restores TS2307. The macOS ARM run
passed with a 75 ms filesystem event batch. The final coalescer must preserve net
create/change/delete semantics as well; this is an explicit review gate.
