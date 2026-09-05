# Third-Party Notices

Cadencr itself is released under the Apache License 2.0 (see [`LICENSE`](./LICENSE)). This file lists the third-party software and brand assets Cadencr builds on, and the licenses under which they are used.

This is a curated, human-maintained summary focused on frameworks users see or interact with. It is not exhaustive — for the full transitive dependency tree, see `pnpm-lock.yaml`, `Cargo.lock`, and each package's upstream repository.

---

## Frontend frameworks

| Component | Upstream | License |
| --- | --- | --- |
| React — UI framework | https://react.dev | MIT |
| Tailwind CSS — styling | https://tailwindcss.com | MIT |
| Radix UI — headless primitives | https://www.radix-ui.com | MIT |
| Lucide — icon set | https://lucide.dev | ISC |
| TanStack Query & Router | https://tanstack.com | MIT |
| Zustand — state | https://github.com/pmndrs/zustand | MIT |
| CodeMirror 6 — editor | https://codemirror.net | MIT |
| Lexical — rich text | https://lexical.dev | MIT |
| celeritty — WebGPU terminal | https://github.com/edjubert/celeritty | MIT |
| Astro — landing site | https://astro.build | MIT |

Cadencr also uses component patterns from **shadcn/ui** (https://ui.shadcn.com, MIT), which is vendored as source rather than installed as a dependency.

celeritty's WASM bundle compiles in **alacritty_terminal** (https://github.com/alacritty/alacritty, Apache-2.0), vendored under celeritty's `crates/terminal-core/vendor/` for its ANSI/VTE parsing.

## Backend service (Rust)

| Component | Upstream | License |
| --- | --- | --- |
| Axum — HTTP framework | https://github.com/tokio-rs/axum | MIT |
| Tokio — async runtime | https://tokio.rs | MIT |
| sqlx — SQL toolkit | https://github.com/launchbadge/sqlx | Apache-2.0 OR MIT |
| reqwest — HTTP client | https://github.com/seanmonstar/reqwest | Apache-2.0 OR MIT |
| utoipa — OpenAPI | https://github.com/juhaku/utoipa | Apache-2.0 OR MIT |
| tracing — structured logging | https://github.com/tokio-rs/tracing | MIT |
| rmcp — MCP server transport | https://github.com/modelcontextprotocol/rust-sdk | Apache-2.0 OR MIT |
| portable-pty — PTY wrapper (vendored, `packages/service/vendor/`) | https://github.com/wez/wezterm | MIT |
| ignore / nucleo-matcher | https://github.com/BurntSushi/ripgrep, https://github.com/helix-editor/nucleo | Unlicense OR MIT, MIT |

## Tooling (dev-only)

| Component | Upstream | License |
| --- | --- | --- |
| Turborepo | https://turborepo.com | MIT |
| Vitest | https://vitest.dev | MIT |
| oxlint / oxfmt — Oxc toolchain | https://oxc.rs | MIT |
| knip | https://github.com/webpro-nl/knip | ISC |
| Husky | https://typicode.github.io/husky | MIT |

---

## Bundled brand assets

Cadencr bundles third-party logos to identify the coding agents and tools it integrates with. These marks are the property of their respective owners. Their inclusion in the UI is a reference to the corresponding product — it is not a claim of ownership, affiliation, partnership, or endorsement.

Files under `packages/desktop/assets/providers/`:

- **`claude.png`** — Anthropic "Claude" mark. © Anthropic. Used here solely to label the Claude Code integration.
- **`codex.png`** — OpenAI "Codex" mark. © OpenAI. Used here solely to label the Codex integration.
- **`opencode.png`** — OpenCode project mark. © OpenCode authors. Used here solely to label the OpenCode integration.

Files under `packages/desktop/assets/`:

- **`zed-logo.png`** — Zed Industries mark. © Zed Industries. Used here solely to label the Zed integration where applicable.

If you own one of these marks and want the asset removed or replaced, please open an issue or email **raphael.leminor@gmail.com** and it will be addressed promptly.

## Cadencr-original assets

The Cadencr name, the Cadencr "Index Dots" logo (`packages/desktop/assets/cadencr-mark-{dark,light}.svg` and `packages/desktop/icons/{128x128.png,icon.icns,icon.ico}`), and the marketing content under `packages/landing/` are original works © 2026 Raphael Le Minor, released under the Apache License 2.0 together with the rest of this repository.
