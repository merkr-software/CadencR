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
- `src/content/` — MDX content collections for news entries
- `src/styles/` — Tailwind v4 import, design tokens, and landing-specific styles
- `design/` — original HTML mockup used as the source of truth for copy and markup
- `public/CNAME` — custom domain marker for `cadencr.com`

## Deployment

Cloudflare Pages is connected directly to the GitHub repository and deploys the landing site from `main`.

Recommended Cloudflare Pages settings:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `corepack enable && pnpm install --frozen-lockfile --filter "@cadencr/landing..." && pnpm --filter @cadencr/landing build` |
| Build output directory | `packages/landing/dist` |
| Environment variable | `NODE_VERSION=22` |

The site canonical URL is configured in `astro.config.mjs`:

```js
site: "https://cadencr.com",
base: "/",
```

If Cloudflare Pages deployment settings change, update this README so the repository remains the source of truth.
