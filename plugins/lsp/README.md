# Marketplace language servers

The catalog preparation covers the 17 previously available servers and eight
additional servers. Package releases target Cadencr **0.16.1 or newer**.
Recipes and qualification artifacts are candidates, not publication authority.

## Coverage

| Package | Coverage | Runtime | Origin |
| --- | --- | --- | --- |
| `typescript-language-server` | TypeScript, JavaScript | Node | Previous catalog; package 0.1.0 published |
| `tsgo` | TypeScript, JavaScript | Native (Cadencr source build) | Previous catalog |
| `biome` | JavaScript, TypeScript, JSON, CSS | Native | Previous catalog |
| `eslint` | Project-configured JavaScript and TypeScript linting | Node | Previous catalog |
| `oxlint` | JavaScript, TypeScript linting | Native | Previous catalog |
| `json-language-server` | JSON, JSONC | Node | Previous catalog |
| `yaml-language-server` | YAML | Node | Previous catalog |
| `html-language-server` | HTML | Node | Previous catalog |
| `css-language-server` | CSS, SCSS, Less | Node | Previous catalog |
| `svelte-language-server` | Svelte | Node | Previous catalog |
| `vue-language-server` | Vue | Node | Previous catalog |
| `astro-ls` | Astro | Node | Previous catalog |
| `bash-language-server` | Shell scripts | Node | Previous catalog |
| `docker-langserver` | Dockerfiles | Node | Previous catalog |
| `rust-analyzer` | Rust | Native | Previous catalog |
| `gopls` | Go | Native | Previous catalog |
| `pyright` | Python | Node | Previous catalog |
| `clangd` | C, C++ | Native | Additional |
| `ruff` | Python linting | Native | Additional |
| `lua-language-server` | Lua | Native | Additional |
| `tailwindcss-language-server` | Tailwind CSS in supported project templates | Node | Additional |
| `graphql-language-server` | GraphQL | Node | Additional |
| `terraform-ls` | Terraform | Native | Additional |
| `taplo` | TOML | Native | Additional |
| `marksman` | Markdown | Native | Additional |

Exact language associations, root markers, arguments, versions, upstream hashes
and required project configuration live in each recipe. Native recipes are in
[`native-recipes`](native-recipes); Node recipes live under their package IDs.

## Runtime requirements

- Node is discovered on the user's machine; installation never invokes npm or
  resolves dependencies. Archives retain the complete selected dependency trees.
  Node **22.19.0** is the common qualification runtime. A signed `node_min_version`
  specifies the lower bound; upstream supported-major restrictions still apply.
- ESLint and Tailwind require the corresponding project dependencies and
  configuration. An installed language server does not install them into a project.
- Rust, Go, C/C++ and Terraform intelligence may require the project's toolchain,
  SDK or CLI. Those toolchains are not bundled into the language-server package.
- Package entrypoints use real upstream `.js` modules or reviewed `.mjs` adapters.
  YAML and Tailwind adapters preserve their original extensionless command wrappers.
- Vue includes a reviewed TypeScript bridge. ESLint and framework adapters supply
  package-owned configuration defaults and bundled SDK paths through standard LSP.
  The application has no server-ID-specific dispatch.
- Native bundles retain required standard libraries, data and redistribution
  notices. They contain one executable entry; other retained files are data.
- The host provides `CADENCR_LSP_CACHE_ROOT`, a writable cache directory isolated
  by server ID. LuaLS expands this variable in its `--logpath` and `--metapath`
  arguments so generated metadata, logs and caches stay outside its installed
  runtime. Installed payloads must retain their reviewed inventory after use.

### Native macOS deployment floors

These are the signed floors declared by the retained Mach-O executables, not
certification that Cadencr runs on each listed OS. Application requirements and
actual runtime qualification are separate. The released-catalog matrix tested
macOS **15.8.2 ARM64** and **15.7.9 Intel**; older OS runtime certification remains
outside that evidence.

| Package | macOS ARM64 binary floor | macOS Intel binary floor |
| --- | --- | --- |
| `biome` | `11.0.0` | `10.12.0` |
| `clangd` | `11.0.0` | `10.13.0` |
| `gopls` | `12.0.0` | `12.0.0` |
| `lua-language-server` | `11.0.0` | `10.12.0` |
| `marksman` | `12.0.0` | `12.0.0` |
| `oxlint` | `11.0.0` | `10.12.0` |
| `ruff` | `11.0.0` | `10.12.0` |
| `rust-analyzer` | `15.0.0` | `15.0.0` |
| `taplo` | `11.0.0` | `10.12.0` |
| `terraform-ls` | `12.0.0` | `12.0.0` |
| `tsgo` | `12.0.0` | `12.0.0` |

Linux and Node targets do not declare a macOS deployment floor. Every promoted
target retains its exact signed runtime requirements in `package-template.json`.

## Qualification and promotion

1. Acquire upstream distributions from locked URLs and verify their hashes and
   complete retained-file inventories. Bind first-party adapters to an immutable
   reviewed Git commit; preserve supplemental license provenance.
2. Pack each target twice with CLI **0.15.6**, compare the bytes and validate the
   package descriptor. Source-built CLI evidence is preparation evidence only;
   final reproduction uses the verified published Linux CLI.
3. Run semantic probes on the exact same bound archives on Linux x86_64, macOS
   ARM64 and macOS Intel. Check the Ubuntu 22.04 runtime baseline separately.
   A successful initialize response alone is insufficient.
4. Verify app installation, editor suggestions, diagnostics after edits, update,
   removal and revocation in an isolated QA setup. Record app-build differences
   and distinguish direct server probes from app-level checks.
5. Promote only qualified archives, manifests, source locks and policy entries
   through the protected official publication pipeline. A workflow artifact never
   grants publication authority.

The existing TypeScript package remains unchanged. Its immutable publication and
runtime evidence are recorded in its [README](typescript-language-server/README.md).

The [released CLI `0.15.6`](https://github.com/merkr-software/CadencR/releases/tag/cli/v0.15.6) qualification binds canonical packaging and all **25 packages on four real hosts** to
[run 42215738947](https://github.com/merkr-software/CadencR/actions/runs/42215738947).
Ubuntu 22.04 and 24.04 x86_64, macOS ARM64 and macOS Intel each pass 25 real
semantic probes using the same canonical archives. The 24 new source entries
are `READY` for protected author inspection; that source preparation status does
not publish assets or establish managed application lifecycle conformance.

## Production boundary

Publishing package releases does **not** activate the production marketplace.
The production catalog must contain no LSP entries and the app's LSP revocation
feed must remain unconfigured until the coordinated **0.16.1** rollout. Publishing
the Cadencr desktop app is a separate, explicitly authorized release step.
