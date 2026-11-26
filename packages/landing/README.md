# @cadencr/landing

Static marketing site, docs, and news for [cadencr.com](https://cadencr.com), built with Astro + MDX + Tailwind v4 and deployed with Cloudflare Pages.

## Scripts

```bash
pnpm --filter @cadencr/landing dev       # http://localhost:4321/
pnpm --filter @cadencr/landing build     # outputs to packages/landing/dist/
pnpm --filter @cadencr/landing preview   # serve dist/ locally
pnpm --filter @cadencr/landing ts-check
pnpm --filter @cadencr/landing lint
pnpm --filter @cadencr/landing format:check
```

## Structure

- `src/pages/` — routes (`index.astro`, `/docs`, `/news`, `404.astro`)
- `src/components/` — section components (Nav, Hero, Features, Footer) and shared primitives
- `src/pages/docs/` — MDX product guides and dedicated library guides
- `src/lib/docs.ts` — documentation metadata and navigation sections, also used by `/llms.txt`
- `src/content/` — MDX content collections for news entries
- `src/styles/` — Tailwind v4 import, design tokens, and landing-specific styles
- `design/` — original HTML mockup used as the source of truth for copy and markup
- `public/CNAME` — custom domain marker for `cadencr.com`

## Library documentation

The docs have separate **Libraries**, **npm packages**, and **Rust crates**
navigation sections. `/docs/libraries/` introduces extension authoring; each
public npm package or Rust crate has its own guide and package README.

When adding or updating a library guide:

1. Edit its MDX page in `src/pages/docs/` and keep the matching metadata in
   `src/lib/docs.ts` in sync. Use the existing `DocLayout.astro` and flat
   route slugs, as with the other documentation pages.
2. Update the package README's installation, compatibility, and quick start.
   Link the README and guide to each other. Package homepages point to these
   guides; Rust `documentation` URLs point to docs.rs for API reference.
3. Check examples against the package exports and protocol specifications in
   `docs/`. Library semver is independent of the desktop version; avoid the
   layout's app-specific `version` frontmatter on library pages.
4. Run the landing checks and build. `src/lib/docs.test.ts` checks that every
   MDX guide appears exactly once in navigation. The docs index, `/llms.txt`,
   and sitemap pick up registered pages automatically.

```bash
pnpm --filter @cadencr/landing format:check
pnpm --filter @cadencr/landing lint
pnpm --filter @cadencr/landing ts-check
pnpm --filter @cadencr/landing test
pnpm --filter @cadencr/landing knip
pnpm --filter @cadencr/landing build
```

## Deployment

Cloudflare Pages is connected directly to the GitHub repository and deploys the landing site from `main`.

Recommended Cloudflare Pages settings:

| Setting                | Value                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Production branch      | `main`                                                                                                                     |
| Root directory         | `/`                                                                                                                        |
| Environment variable   | `SKIP_DEPENDENCY_INSTALL=1`                                                                                                |
| Build command          | `corepack enable && pnpm install --frozen-lockfile --filter "@cadencr/landing..." && pnpm --filter @cadencr/landing build` |
| Build output directory | `packages/landing/dist`                                                                                                    |

Corepack selects pnpm from the root `packageManager` field. The filtered install
provisions the Node.js version declared in landing's `devEngines.runtime` using
the platform archive and checksum in `pnpm-lock.yaml`. The hoisted install links
that executable in the shared `node_modules/.bin`. This lets pnpm launch Astro
for build, dev and preview on an older host Node.js. Other workspace scripts
run through pnpm can also resolve `node` from that shared directory. When
updating Node.js, keep the landing runtime aligned with `.nvmrc`, `.node-version`
and the workspace's `nodeVersion` engine-check setting, then regenerate the
lockfile.

To verify the Pages build with the older host, run the build command from the
table in a clean Linux x64 checkout with Node.js `22.19.0` on `PATH` (for example,
in the `node:22.19.0-bookworm` container) and `SKIP_DEPENDENCY_INSTALL=1`. Check
that the system runtime stays at `v22.19.0`, pnpm resolves the pinned runtime,
and the build produces `packages/landing/dist/rss.xml` alongside the HTML pages.

```bash
node --version
pnpm --version
pnpm --filter @cadencr/landing exec node --version
pnpm --filter @cadencr/landing test
```

Repeat with the host version in `.nvmrc` to verify the usual development setup.

If a Pages build fails with `ERR_PNPM_ENOENT` while renaming a `_tmp_*`
directory in the hoisted `node_modules` tree, use **Retry deployment** on the
failed deployment. Wait until the Pages dashboard shows a successful production
deployment for the intended commit. Then verify that the live download page links
to the expected release.

The site canonical URL is configured in `astro.config.mjs`:

```js
site: "https://cadencr.com",
base: "/",
```

If Cloudflare Pages deployment settings change, update this README so the repository remains the source of truth.
