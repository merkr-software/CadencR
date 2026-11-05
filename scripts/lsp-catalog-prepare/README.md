# Held Node LSP candidate preparation

## Scope

- Recipes under `plugins/lsp/<id>/recipe.json` preserve existing server IDs.
- All runtime packages are exact official npm tarballs with a complete frozen production dependency graph.
- The app never resolves dependencies, installs packages or executes lifecycle scripts.
- Source acquisition, local runtime smoke and canonical archive preparation are separate evidence. None grants publication authority.
- The desktop release and production catalogue/feed activation remain outside this preparation.

## Acquisition

`node_acquire.py` consumes the committed `payload/npm-lock.json`; it does not run npm or resolve a tag. It verifies npm SHA512 integrity, SHA256 and every regular tar member. Upstream notices, optional-package decisions, engine ranges and lifecycle declarations remain in provenance. Nonregular members, duplicate files, traversal and mixed archive roots fail explicitly.

```sh
python3 -B scripts/lsp-catalog-prepare/node_acquire.py \
  --npm-lock plugins/lsp/pyright/payload/npm-lock.json \
  --id pyright --entry node_modules/pyright/langserver.index.js \
  --cache /absolute/private/npm-cache \
  --output /absolute/private/new-pyright-candidate
```

For an adapter recipe, acquisition uses its `upstream_entry`. Astro explicitly includes optional compiler packages `node_modules/@astrojs/compiler-binding-darwin-arm64`, `node_modules/@astrojs/compiler-binding-darwin-x64` and `node_modules/@astrojs/compiler-binding-linux-x64-gnu` with three `--include-optional` arguments. Other-target native packages are documented omissions; Pyright's optional `fsevents` accelerator is omitted.

## Immutable first-party overlays

ESLint, Astro and Svelte use the data-driven `adapter.mjs` with reviewed per-package configuration. Vue uses its own adapter around unmodified upstream Vue and TypeScript processes. SDK paths are resolved from the installed bundle. ESLint configuration fills empty host defaults and preserves explicit host values. The Vue adapter bridges upstream custom notifications and maps TypeScript diagnostics, hover, completion, definitions and references to original Vue source positions.

```sh
python3 -B scripts/lsp-catalog-prepare/node_overlay.py \
  --source-commit ACTUAL_REVIEWED_40_HEX_GIT_COMMIT \
  --recipe plugins/lsp/vue-language-server/recipe.json \
  --candidate /absolute/private/fresh-vue-acquisition
```

The helper accepts only exact immutable commits and reads mode `100644` Git blobs. Each committed file becomes one source with an immutable `raw.githubusercontent.com` URL and a SHA256 of exactly the file bytes returned by that URL. Source names are unique within the shared destination. A deterministic synthesized archive is retained only as private evidence; its digest is never presented as the contents of a source URL. The helper updates the candidate entry and cannot bind uncommitted adapter source. The source lock in an adapter recipe remains pending until this step has completed and its result is reviewed.

## Real language features

```sh
python3 -B scripts/lsp-catalog-prepare/node_smoke.py \
  --recipe plugins/lsp/vue-language-server/recipe.json \
  --bundle /absolute/extracted-canonical-bundle \
  --node /absolute/node22.19.0 \
  --work /absolute/private/new-smoke-work \
  --output /absolute/private/smoke-evidence.json \
  --empty-host-settings
```

macOS runs Node inside `sandbox-exec` with denied network. Linux must run inside a separate unprivileged network namespace; the helper refuses a non-loopback interface. Node receives a fresh private home and an explicit credential-free environment. Initialization alone cannot pass: each fixture requires a diagnostic, hover, completion or symbol. Vue additionally requires mapped TypeScript hover and diagnostics clearing after a live edit.

ESLint and Tailwind require real project dependencies. Their frozen fixtures are under `fixtures/eslint` and `fixtures/tailwind`. Acquire them with the same helper, using respectively `--id eslint-fixture --entry node_modules/eslint/bin/eslint.js` and `--id tailwind-fixture --entry node_modules/tailwindcss/dist/lib.js`. Supply the acquired `bundle/node_modules` as `--project-dependencies`. These dependencies are project fixtures and are not silently added to the server bundle.

## Canonical packing and platform limits

The full current Pyright, VS Code extracted servers and GraphQL distributions exceed CLI 0.15.5's 4096-entry bound. Prepare canonical archives only with the reviewed released Linux CLI 0.15.6 and its bounded LSP entry policy. Source-built macOS compression is not byte-equivalent evidence. The complete GraphQL graph has 10099 files and 1205 directories, below 16384 total entries.

Local macOS ARM semantic evidence does not qualify Linux, Intel macOS or the final canonical archive. The held qualification workflow must consume the exact same canonical bytes on all three platforms.

## Helper checks

```sh
python3 -B -m unittest discover -s scripts/lsp-catalog-prepare -p 'test_*.py'
node --test scripts/lsp-catalog-prepare/adapter.test.mjs
```
