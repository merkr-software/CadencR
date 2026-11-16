/**
 * The stylesheet every HTML visual starts from: Cadencr's look (DESIGN.md:
 * Inter 13px body, hairline borders, 6–10px radii, flat surfaces) on top of
 * the theme tokens, the MCP Apps standard variable names mapped onto them,
 * and the few classes the `/cadencr:visualize` skill documents. Agents add
 * their own CSS after it.
 */
export const VISUAL_KIT_CSS = `
:root {
  --color-background-primary: var(--background);
  --color-background-secondary: var(--card);
  --color-background-tertiary: var(--muted);
  --color-background-inverse: var(--foreground);
  --color-background-ghost: transparent;
  --color-background-info: color-mix(in oklab, var(--acc-cyan) 14%, transparent);
  --color-background-danger: color-mix(in oklab, var(--destructive) 14%, transparent);
  --color-background-success: color-mix(in oklab, var(--acc-green) 14%, transparent);
  --color-background-warning: color-mix(in oklab, var(--acc-yellow) 14%, transparent);
  --color-text-primary: var(--foreground);
  --color-text-secondary: var(--muted-foreground);
  --color-text-tertiary: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  --color-text-inverse: var(--background);
  --color-text-info: var(--acc-cyan);
  --color-text-danger: var(--destructive);
  --color-text-success: var(--acc-green);
  --color-text-warning: var(--acc-yellow);
  --color-border-primary: var(--border);
  --color-border-secondary: color-mix(in oklab, var(--border) 60%, transparent);
  --color-border-tertiary: color-mix(in oklab, var(--border) 35%, transparent);
  --color-border-info: color-mix(in oklab, var(--acc-cyan) 40%, transparent);
  --color-border-danger: color-mix(in oklab, var(--destructive) 40%, transparent);
  --color-border-success: color-mix(in oklab, var(--acc-green) 40%, transparent);
  --color-border-warning: color-mix(in oklab, var(--acc-yellow) 40%, transparent);
  --color-ring-primary: var(--ring);
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  --font-text-xs-size: 11px;
  --font-text-sm-size: 12px;
  --font-text-md-size: 13px;
  --font-text-lg-size: 14px;
  --font-heading-sm-size: 14px;
  --font-heading-md-size: 17px;
  --font-heading-lg-size: 22px;
  --border-radius-xs: 4px;
  --border-radius-sm: 6px;
  --border-radius-md: 8px;
  --border-radius-lg: 10px;
  --border-radius-xl: 12px;
  --border-radius-full: 9999px;
  --border-width-regular: 1px;
}
*, *::before, *::after { box-sizing: border-box; }
html { height: auto; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  display: flow-root;
  padding: 2px;
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.55;
  color: var(--foreground);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { margin: 0 0 8px; line-height: 1.25; color: var(--foreground); }
h1 { font-size: 17px; font-weight: 700; }
h2 { font-size: 14px; font-weight: 600; }
h3 { font-size: 13px; font-weight: 600; }
p { margin: 0 0 8px; }
a { color: var(--primary); }
code, pre, .mono { font-family: var(--font-mono); font-size: 12px; }
svg { max-width: 100%; }
.muted { color: var(--muted-foreground); }
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 11px; font-weight: 500; color: var(--muted-foreground); }
.stat-value { font-size: 22px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.stat-delta { font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.stat-delta.good { color: var(--acc-green); }
.stat-delta.bad { color: var(--acc-red); }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--border);
  font-size: 11px;
  font-weight: 500;
  color: var(--foreground);
  background: color-mix(in oklab, var(--foreground) 6%, transparent);
}
.badge.success { color: var(--acc-green); border-color: var(--color-border-success); background: var(--color-background-success); }
.badge.danger { color: var(--acc-red); border-color: var(--color-border-danger); background: var(--color-background-danger); }
.badge.warning { color: var(--acc-yellow); border-color: var(--color-border-warning); background: var(--color-background-warning); }
.badge.info { color: var(--acc-cyan); border-color: var(--color-border-info); background: var(--color-background-info); }
button, input, select, textarea { font: inherit; color: inherit; }
button {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: color-mix(in oklab, var(--foreground) 4%, transparent);
  cursor: pointer;
}
button:hover { background: color-mix(in oklab, var(--foreground) 8%, transparent); }
input[type="text"], input[type="number"], input:not([type]), select, textarea {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--input, var(--border));
  background: var(--background);
}
input[type="range"] { accent-color: var(--primary); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
th { background: var(--muted); font-weight: 600; }
`;
