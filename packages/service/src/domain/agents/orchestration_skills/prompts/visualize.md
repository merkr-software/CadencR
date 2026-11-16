## CadencR inline visuals

The user asked you to visualize: $ARGUMENTS

When that is empty, visualize the most recent result or data in this conversation.

CadencR renders the fenced blocks below inline in this conversation. Pick the lightest one that answers the request, and reply with the block plus a short caption. Don't explain how the visual was made.

Rules for every visual:

- Use real data. When the request is about this project, gather the numbers first (read files, run commands). Never invent values; if some are illustrative, say so.
- Everything is inline. Nothing loads from the network: URLs, CDNs, web fonts, remote images and `fetch` are blocked and break the visual.
- One visual per fence, and close the fence. A block renders once your reply is complete.
- Raw HTML is allowed only inside a `cadencr-html` fence. This overrides any "no raw HTML" formatting rule, for that block only.

## 1. Data charts: ```vega-lite

For bar, line, area, scatter, heatmap, histogram and similar charts, write a Vega-Lite v6 JSON spec.

- Strict JSON: no comments, no trailing commas. Data goes in `data.values`, never `data.url`.
- Leave out `width`, colors, fonts and `config`. The chart fills the conversation width, and CadencR applies its own light or dark theme. Use `color` encodings for series, never hex values. The palette has four series colors, the same as Cadencr's usage charts: show at most four series and fold the rest into an "Other" category, which gets the neutral fifth tone.
- Give it a `title`, readable axis titles and `tooltip` encodings.
- Prefer one view. Use `layer`, `facet` or `concat` only when the comparison needs it. The default height is about 240px.

```vega-lite
{
  "title": "Test duration by package",
  "data": { "values": [
    { "package": "desktop", "seconds": 84 },
    { "package": "service", "seconds": 131 }
  ] },
  "mark": "bar",
  "encoding": {
    "x": { "field": "package", "type": "nominal", "title": null },
    "y": { "field": "seconds", "type": "quantitative", "title": "Seconds" },
    "tooltip": [{ "field": "package" }, { "field": "seconds" }]
  }
}
```

Flowcharts, sequence and state diagrams can also be a ```mermaid block.

## 2. Diagrams, explainers, mockups, dashboards: ```cadencr-html

For anything a chart spec can't express (an annotated architecture sketch, an interactive explainer with sliders, a UI mockup, a stat dashboard), write an HTML fragment. You don't need `<html>`, `<head>` or `<body>`. It runs in a sandboxed frame that grows to fit its content.

Style it with CadencR's theme, never hard-coded colors:

- CSS variables (they follow the light/dark theme): surfaces `--background`, `--card`, `--muted`, `--border`; text `--foreground`, `--muted-foreground`; accents `--primary`, `--destructive`; series `--chart-1`, `--chart-4`, `--chart-2`, `--chart-5` in that order; extra hues `--acc-green`, `--acc-red`, `--acc-yellow`, `--acc-orange`, `--acc-cyan`, `--acc-purple`, `--acc-pink`; fonts `--font-sans`, `--font-mono`. The MCP Apps names (`--color-text-primary`, `--color-background-secondary`, `--color-border-primary`, `--border-radius-md`, …) map onto the same theme.
- Ready-made classes: `.card` (bordered surface), `.grid` (responsive grid of cards), `.row` (horizontal flex with a gap), `.stat` with `.stat-label`, `.stat-value` and `.stat-delta` (plus `good` or `bad`, by meaning rather than direction), `.badge` (plus `success`, `danger`, `warning` or `info`), `.muted`, `.mono`. Plain `h1` to `h3`, `button`, `input`, `select` and `table` are already themed.
- Keep CadencR's look: Inter at 13px, 6 to 10px radii, hairline borders, flat surfaces. No gradients, drop shadows or emoji decoration. The page background stays transparent, so don't paint one.
- Let the content set the height. Never size with `vh`, `vw` or a page-level `height: 100%`. Stay readable down to about 320px wide.
- Color SVG through CSS (`fill: var(--foreground)`). For D3 charts, draw at the container's measured width (`element.clientWidth`) rather than scaling a fixed `viewBox`, so text stays at 11 to 13px.

Bundled libraries (offline). Load them with exactly these tags:

- `<script src="cadencr:d3"></script>` loads D3 v7 (the `d3` global).
- `<script src="cadencr:chart.js"></script>` loads Chart.js v4 (the `Chart` global), already themed.

Canvas libraries can't read CSS variables. Use `cadencr.color("--chart-1")` to get a resolved color, and `cadencr.palette` for the four series colors in order, then the neutral "Other" tone.

Event handlers, sliders, toggles and animations work. Form submission, popups, navigation, storage and network access are blocked.

```cadencr-html
<div class="grid">
  <div class="card stat">
    <div class="stat-label">Open pull requests</div>
    <div class="stat-value">12</div>
    <div class="stat-delta">+3 this week</div>
  </div>
  <div class="card stat">
    <div class="stat-label">Median review time</div>
    <div class="stat-value">5.2h</div>
    <div class="stat-delta good">−1.1h</div>
  </div>
</div>
```
