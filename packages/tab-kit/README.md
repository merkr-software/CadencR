# @cadencr/tab-kit

Cadencr's look for **custom tabs**: theme tokens, a Tailwind CSS v4 preset, the
Inter UI font, and the desktop app's own React components. Use it with
`@cadencr/tab-sdk`, which keeps the tokens in sync with the live
Cadencr theme.

[Documentation](https://cadencr.com/docs/tab-kit/) ·
[npm](https://www.npmjs.com/package/@cadencr/tab-kit) ·
[Custom tab quick start](https://cadencr.com/docs/libraries/#create-your-first-custom-tab)

## Install

In a React + Vite tab project:

```bash
npm install @cadencr/tab-kit @cadencr/tab-sdk react@^19 react-dom@^19
npm install -D tailwindcss@^4 @tailwindcss/vite@^4
```

The package is ESM with TypeScript declarations. For TypeScript consumers,
also install the types referenced by the component declarations:

```bash
npm install -D @types/react@^19 @types/react-dom@^19 radix-ui class-variance-authority clsx
```

## Setup

Enable Tailwind v4 in your Vite configuration (keep your existing React plugin):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
```

```css
/* src/styles.css */
@import "tailwindcss";
@import "@cadencr/tab-kit/preset.css";
```

```tsx
import { CadencrProvider } from "@cadencr/tab-sdk/react";
import { Badge, Button } from "@cadencr/tab-kit";
import "./styles.css";

export function App() {
  return (
    <CadencrProvider
      fallback={<p>Connecting…</p>}
      errorFallback={(error) => <p role="alert">{error.message}</p>}
    >
      <main className="bg-background p-4 text-foreground">
        <Button variant="outline">
          Refresh <Badge variant="secondary">3</Badge>
        </Button>
      </main>
    </CadencrProvider>
  );
}
```

The preset needs `@tailwindcss/vite` (or another Tailwind v4 integration) in
your build. Everything else — fonts, animations, component styles — ships in
the package; nothing is fetched at runtime.

Mount `App` in your React entry point. Use `vite build --watch` to update the
static bundle Cadencr loads; `base: "./"` keeps asset URLs relative. The
preset registers the compiled component classes with Tailwind automatically.
The SDK provider applies and updates the live host theme. For a non-React
page, call `connect()` from `@cadencr/tab-sdk` instead.

## What's inside

| Entry                         | Contents                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@cadencr/tab-kit/tokens.css` | Default `--cadencr-*` values: CadencR Dark on `:root` and `[data-appearance="dark"]`, CadencR Light on `[data-appearance="light"]`. |
| `@cadencr/tab-kit/fonts.css`  | Inter Variable (100–900), the desktop UI font, bundled.                                                                             |
| `@cadencr/tab-kit/preset.css` | Imports both, maps Tailwind's theme onto the tokens, sets the base layer, and registers the components' classes.                    |
| `@cadencr/tab-kit`            | React components and `cn()`.                                                                                                        |

### Utilities

The preset uses the desktop app's utility names: `bg-background`,
`text-foreground`, `bg-card`, `bg-popover`, `bg-primary`,
`text-primary-foreground`, `bg-secondary`, `bg-muted`, `text-muted-foreground`,
`bg-accent`, `bg-destructive`, `border-border`, `border-input`, `ring-ring`,
`bg-chart-1`…`bg-chart-5`, `bg-sidebar*`, `bg-surface-sunken`, `text-acc-green`
(and `acc-cyan`, `orange`, `pink`, `purple`, `red`, `yellow`, `comment`),
`text-numstat-add-fg` / `text-numstat-del-fg` (line counts),
`bg-diff-add-bg` / `bg-diff-del-bg` (+ `-strong`, diff rows),
`rounded-sm/md/lg/xl`, `font-sans` (Inter) and `font-mono` (the desktop's system monospace stack). `dark:` follows
the Cadencr theme (`data-appearance`), not the OS setting. Every other theme
token is available as a CSS variable, e.g. `var(--cadencr-diff-add-bg)`.

### Components

`Badge`, `Button`, `Checkbox`, `ContextMenu*`, `DropdownMenu*`, `Input`,
`Popover*` (+ `PopoverModality`), `Progress`, `ScrollArea`, `Select*`,
`Separator`, `Skeleton`, `Switch`, `Tabs*`, `Textarea`, `Tooltip*` (wrap the
tree in `TooltipProvider`), and `cn`. They are the exact components the
desktop app renders (`packages/desktop/src/components/ui`), compiled — not a
copy.

Kit-native primitives (desktop has no generic equivalent, so they live in the
kit, styled only with the tokens and following the desktop settings-card
anatomy): `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`,
`CardFooter` — a recessed `surface-sunken` panel, `rounded-xl`, a 60% hairline;
`Label`; and `EmptyState({ icon?, title, description?, action? })`.

### Icons

The desktop draws its icons with [Lucide](https://lucide.dev). The kit does
not re-export them: add `lucide-react` to your tab (the scaffold does) and
import what you need, so you get the whole set with its types and your build
keeps only the icons you use:

```tsx
import { RefreshCw } from "lucide-react";

<Button variant="ghost" size="icon-xs" aria-label="Refresh">
  <RefreshCw />
</Button>;
```

Kit components size a child `<svg>` themselves; elsewhere use `size-4`-style
utilities. Icons inherit `currentColor`.

### Bundling

Radix, class-variance-authority, clsx, tailwind-merge and lucide-react are
bundled; only `react` and `react-dom` are runtime peer dependencies. See
[Install](#install) for the declaration dependencies needed by TypeScript consumers.

## Troubleshooting

| Symptom                                      | Check                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Missing component styles                     | Enable Tailwind v4 and import `preset.css` after `tailwindcss`.        |
| Default colors after changing the host theme | Mount the SDK provider or call `connect()`; keep `applyTheme` enabled. |
| Missing fonts inside Cadencr                 | Use relative asset URLs and bundle files locally.                      |
| Cannot resolve declaration types             | Install the dev dependencies listed under Install.                     |

For plain CSS, import `tokens.css` and use `var(--cadencr-background)` and
other tokens directly. Default dark/light tokens work without a host; the
SDK replaces them with the live theme when connected. The package follows
its own semver, independent of the app.

## Licenses

Apache-2.0. Bundled third-party code is listed with its licenses in
`dist/THIRD_PARTY_LICENSES.txt`; Inter is under the SIL Open Font License
(`dist/fonts/OFL.txt`).

## Development

```bash
pnpm --filter @cadencr/tab-kit build            # dist/
pnpm --filter @cadencr/tab-kit test             # build + drift, boundary and example-consumer tests
pnpm --filter @cadencr/tab-kit generate:tokens  # refresh tokens.css from the desktop themes
```

`tokens.css` is generated from `packages/desktop/src/theme-cadencr.css`,
restricted to the token list in `packages/desktop/src/lib/themes/tokens.ts`; a
test fails when it drifts. Only self-contained desktop components can be
exported — a test fails if one starts importing app code. `example/` is a
private consumer the tests build to prove Tailwind generates the components'
classes.
