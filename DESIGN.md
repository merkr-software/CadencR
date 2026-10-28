---
# Cadencr Desktop — Design tokens and system definition
# Source of truth: Page - Unified agents.html
# Secondary: Page - Session.html (split-stacked layout reference only)

meta:
  project: Cadencr Desktop
  source_of_truth: Page - Unified agents.html
  secondary_reference: Page - Session.html
  default_theme: cadencr-dark
  default_screen: workspace # Unified agents page lands on "unified"; Session lands on "workspace"

brand:
  direction: Emerald Reserve
  validated: 2026-07
  dark:
    ground: "#131416"
    rail: "#090A0C"
    raised: "#1A1B1D"
    foreground: "#EFF0F2"
    foreground_soft: "#A7A9AD"
    foreground_muted: "#6E7176"
    hairline: "#34373A"
    primary: "#2DB47D"
  light:
    ground: "#FAFAFB"
    rail: "#EFF0F2"
    raised: "#FFFFFF"
    foreground: "#222429"
    foreground_soft: "#60636A"
    foreground_muted: "#95989F"
    hairline: "#D7DADD"
    primary: "#087653"
  functional:
    dark:
      {
        file_change: "#8BCF67",
        edit_heading: "#F09A5B",
        deletion: "#EC707B",
        thinking: "#52BFD0",
        warning: "#E2B64D",
        generic_tool: "#6D9BEC",
        syntax: "#DE7CA7",
      }
    light:
      {
        file_change: "#3D7D14",
        edit_heading: "#A84F00",
        deletion: "#D12D49",
        thinking: "#007F9B",
        warning: "#966C00",
        generic_tool: "#1D5ED8",
        syntax: "#B52B70",
      }

themes:
  # CadencR Dark and Light are the product defaults. Aurora, Dracula, and
  # One Dark remain supported alternatives and keep their existing palettes.

  cadencr_dark:
    id: cadencr-dark
    label: CadencR Dark
    appearance: dark
    background: "#131416"
    surface: "#1A1B1D"
    surface_sunken: "#08090B"
    sidebar: "#090A0C"
    border: "#34373A"
    text_primary: "#EFF0F2"
    text_secondary: "#A7A9AD"
    text_muted: "#6E7176"
    accent: "#2DB47D"
    accent_thinking: "#52BFD0"
    accent_thinking_bg: "#1E272A"
    thinking_text: "#C1D2D5"
    edit_heading: "#F09A5B"
    success: "#8BCF67"
    danger: "#EC707B"
    warning: "#E2B64D"
    info: "#6D9BEC"
    syntax: "#DE7CA7"
    code_bg: "#08090B"
    code_fg: "#EFF0F2"
    user_message_bg: "#19231F"
    user_message_border: "#315447"

  cadencr_light:
    id: cadencr-light
    label: CadencR Light
    appearance: light
    background: "#FAFAFB"
    surface: "#FFFFFF"
    surface_sunken: "#F4F5F7"
    sidebar: "#EFF0F2"
    border: "#D7DADD"
    text_primary: "#222429"
    text_secondary: "#60636A"
    text_muted: "#95989F"
    accent: "#087653"
    accent_thinking: "#007F9B"
    accent_thinking_bg: "#F0F7F9"
    thinking_text: "#2F454B"
    edit_heading: "#A84F00"
    success: "#3D7D14"
    danger: "#D12D49"
    warning: "#966C00"
    info: "#1D5ED8"
    syntax: "#B52B70"
    code_bg: "#F4F5F7"
    code_fg: "#222429"
    user_message_bg: "#F1F6F3"
    user_message_border: "#A9C7BA"

  aurora:
    id: aurora
    label: Aurora
    appearance: light
    data_theme_key: light
    file: themes/aurora.json
    background: oklch(0.985 0.004 290)
    surface: oklch(1 0 0) # --card
    surface_elevated: oklch(0.965 0.008 290) # sidebar / background-deep
    border: oklch(0.905 0.015 290)
    text_primary: oklch(0.205 0.040 285)
    text_secondary: oklch(0.32 0.040 285) # --foreground-soft
    text_muted: oklch(0.46 0.040 285)
    accent: oklch(0.55 0.245 295) # --primary (also --acc-purple)
    accent_violet: oklch(0.45 0.20 295) # blocks.thinking-accent — for Thinking blocks ONLY
    accent_thinking_bg: oklch(0.96 0.04 295)
    success: oklch(0.58 0.18 150) # --acc-green — ready dot, +diffs
    danger: oklch(0.58 0.22 25) # --acc-red — retry counter, -diffs
    warning: oklch(0.66 0.18 55) # --acc-orange — "in progress" / dev pill
    info: oklch(0.58 0.13 220) # --acc-cyan — file refs
    code_bg: oklch(0.97 0.008 290)
    code_fg: oklch(0.205 0.04 285)

  dracula:
    id: dracula
    label: Dracula
    appearance: dark
    data_theme_key: dark
    file: themes/dracula.json
    background: oklch(0.22 0.022 277.497)
    surface: oklch(0.22 0.022 277.497) # --card
    surface_elevated: oklch(0.23 0.022 277.497) # --sidebar
    border: oklch(0.32 0.032 277.821)
    text_primary: oklch(0.977 0.008 106.793)
    text_secondary: oklch(0.85 0.012 277.5) # --foreground-soft
    text_muted: oklch(0.56 0.08 270.087)
    accent: oklch(0.742 0.149 301.871) # #bd93f9 — Dracula purple
    accent_violet: "#dbb1ff" # blocks.thinking-accent
    accent_thinking_bg: "#1f1d31"
    success: "#50fa7b"
    danger: "#ff5555"
    warning: "#ffb86c"
    info: "#8be9fd"
    code_bg: "#1a1b26"
    code_fg: "#f8f8f2"
    dracula_pink: "#ff79c6" # mention chip identity in dark theme
    dracula_yellow: "#f1fa8c"
    dracula_comment: "#6272a4"

  one_dark:
    id: one-dark
    label: One Dark
    appearance: dark
    data_theme_key: onedark
    file: themes/one-dark.json
    background: oklch(0.27 0.014 257) # ~#282c34
    surface: oklch(0.27 0.014 257) # --card
    surface_elevated: oklch(0.25 0.012 257) # --sidebar
    border: oklch(0.34 0.014 257) # ~#3e4451
    text_primary: oklch(0.78 0.018 257) # ~#abb2bf
    text_secondary: oklch(0.760 0.014 245)
    text_muted: oklch(0.58 0.018 257) # ~#5c6370
    accent: oklch(0.72 0.13 240) # #61afef — One Dark blue
    accent_violet: "#c678dd" # blocks.thinking-accent — One Dark magenta
    accent_thinking_bg: "#2a2533"
    success: "#98c379"
    danger: "#e06c75"
    warning: "#d19a66"
    info: "#56b6c2"
    code_bg: "#21252b"
    code_fg: "#abb2bf"

# ─── Typography ──────────────────────────────────────────────────────────
typography:
  families:
    brand:
      stack: '"Figtree Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
      role: Brand wordmark — the "CADENCR" logotype, rendered at weight 800 (see --font-brand)
    ui:
      stack: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
      role: All UI text — sidebar, tabs, prompts, agent prose
    mono:
      stack: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      role: Code blocks, terminal, diff gutters, file paths, tool-call bodies, +/- counters

  scale:
    h_section_user:
      {
        size: 22px,
        weight: 700,
        line_height: 1.25,
        letter_spacing: -0.01em,
        role: "Agent stream — user-section heading (.cds-section h3)",
      }
    h_section_agent:
      {
        size: 17px,
        weight: 700,
        role: "Agent stream — agent-section heading (.cds-section h3.green)",
      }
    body: { size: 14px, weight: 400, line_height: 1.55, role: "Default body — html/body" }
    body_stream: { size: 13.5px, line_height: 1.55, role: "Agent stream prose (.cds-stream)" }
    bubble: { size: 13px, line_height: 1.55, role: "User bubble (.cds-user-bubble)" }
    tab: { size: 12.5px, weight: 500, role: "Tab strip label" }
    feature_row: { size: 12.5px, role: "Sidebar feature row" }
    chip: { size: 11.5px, weight: 500, role: "Action-bar chip" }
    tool_call: { size: 11.5px, family: mono, role: ".cds-tool — collapsed tool-call row" }
    tool_term: { size: 11px, family: mono, line_height: 1.65, role: "Bash tool output" }
    diff: { size: 12px, family: mono, line_height: 1.7, role: "Diff body / code blocks" }
    git_diff: { size: 11.5px, family: mono, line_height: 1.65, role: "Git tab diff body" }
    editor: { size: 11.5px, family: mono, line_height: 1.7, role: "Editor pane code" }
    eyebrow:
      {
        size: 11px,
        weight: 600,
        transform: uppercase,
        letter_spacing: 0.08em,
        color: "--foreground at 65%",
        role: "Sidebar section labels (FOR ME, PINNED, PROJECTS), under a hairline divider",
      }
    meta_user: { size: 10.5px, family: mono, role: "User/agent timestamp meta" }
    context_bar: { size: 10.5px, family: mono, role: "Context % footer" }
    beta_badge: { size: 8px, weight: 700, transform: uppercase, role: "BETA/dev badge" }
    git_meta: { size: 11px, family: mono, role: "Branch + +/- counters in tab strip" }

# ─── Spacing scale (extracted from kit.css) ───────────────────────────────
spacing:
  # Most kit.css values cluster on these steps. New components MUST pick from this list.
  steps:
    - 0
    - 2px
    - 4px
    - 6px
    - 7px # used for tab strip (padding 7px 14px) — reserved for tabs
    - 8px
    - 9px
    - 10px
    - 12px
    - 14px
    - 16px
    - 18px
    - 22px

  fixed_widths:
    sidebar: 268px
    pane_right_default: 380px
    pane_right_wide: 460px
    pane_right_stacked: 520px
    sidebar_header_height: 56px
    topbar_min_height: 52px
    explorer: 200px

# ─── Radii ────────────────────────────────────────────────────────────────
radii:
  base: 0.625rem # --radius
  sm: 6px # --radius-sm
  md: 8px # --radius-md
  lg: 10px # --radius-lg
  pill: 9999px # status dots, traffic lights

# ─── Shadows ──────────────────────────────────────────────────────────────
shadows:
  pop_dark: "0 8px 30px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.25)" # dracula
  pop_onedark: "0 8px 30px rgba(0,0,0,.40), 0 2px 6px rgba(0,0,0,.22)"
  pop_light: "0 12px 36px -10px oklch(0.50 0.20 295 / 0.22), 0 2px 8px -2px oklch(0.30 0.10 285 / 0.10)"
  card_subtle: "0 1px 2px rgba(0,0,0,0.06)" # active button on theme switch

# ─── Transitions ──────────────────────────────────────────────────────────
transitions:
  fast: 120ms
  default: 150ms
  theme_swap: 220ms ease # html/body background+color
  hover: 100ms
  easing_default: ease

# ─── Layouts ──────────────────────────────────────────────────────────────
layouts:
  single:
    grid_template_columns: "1fr"
    description: "All four tabs in the root pane. Default for Unified agents view; also fine for narrow viewports."
    used_by: Page - Unified agents.html
  split:
    grid_template_columns: "1fr 380px"
    description: "Root pane: agent + terminal · Right floating: git + editor"
  split-stacked:
    grid_template_columns: "1fr 520px"
    grid_template_rows_right: "1fr 1fr"
    description: "Root pane: agent solo · Right is vertically split — Terminal top, Git+Editor bottom. The canonical Session layout."
    used_by: Page - Session.html
  wide:
    grid_template_columns: "1fr 460px"
    description: "Root pane: agent solo · Right floating: git + editor + terminal in one tab strip"

# ─── Status palette (RESERVED — never reuse for decoration) ───────────────
status:
  ready: success # green dot in worktree row, agent feat-title dot
  in_progress: warning # orange — feature row "in progress" pill
  retry: danger # red — retry counter on prompt action bar
  thinking: accent_violet # legacy schema name; resolves to the theme-owned thinking accent

# ─── Iconography ─────────────────────────────────────────────────────────
iconography:
  library: Lucide-style hand-rolled SVGs in icons.jsx
  stroke_width: 2
  default_size: 14
  small: 13
  micro: 10..12
  fill: none (stroke-only)
  rule: All glyphs use currentColor — never hard-code stroke/fill in the icon component
---

# Cadencr Desktop — Design System

## Brief

**What it is.** Cadencr Desktop is the developer-facing control surface for managing autonomous coding agents across multiple projects and worktrees. It is a single-window, four-pane workspace that lets a human supervise an agent's reasoning (Agent), watch it execute (Terminal), inspect what changed (Git), and verify or make focused corrections to the result (Editor) — all from one screen, without context-switching.

**Who it's for.** Senior individual contributors and tech leads who run multiple parallel agent sessions and need to scrub through reasoning, terminal output, and diffs faster than a chat thread allows. The product assumes the user reads code, knows what a worktree is, and prefers keyboard-driven dense IDEs over chat-style UIs.

**What it is NOT.** It is not a chat app — the agent stream is a transcript artifact, not a conversation surface. It is not a general-purpose code authoring IDE: the Editor remains review-first, while permitting focused file edits and conflict resolution when verification reveals work to correct. It is not a generic AI sidebar; it is the primary workspace.

## Brand identity (validated 2026-07 — "Emerald Reserve")

The brand direction was re-validated in July 2026 through the in-product palette exploration in `packages/landing/palette-exploration.html` and Raphael's iterative review. The landing leads and the `cadencr-dark` / `cadencr-light` defaults follow the same handoff tokens. Legacy themes keep their own identities.

- **Logo — "Index Dots".** Twelve ink dots (r1.9) on a r14.5 ring around a solid emerald core (r5.5), on a 48 grid. Distilled from the original dotted-ring favicon; two colors only. Favicon / ≤32px raster cut: dots r3, core r7. Core color: emerald `#2DB47D` on dark grounds, emerald-deep `#087653` on light. Dots always take the surrounding ink color (`currentColor`). The old multi-color agent arcs are retired. These values live in code in `packages/brand` — edit them there and run `pnpm brand:install` rather than hand-editing any icon.
- **Wordmark.** `CADENCR` in Figtree, weight 800, uppercase, tracked ~0.05em — unchanged (`--font-brand` already renders this).
- **Dark handoff.** Ground `#131416`, darker rail `#090A0C`, Raised `#1A1B1D`, Ink `#EFF0F2`, Soft `#A7A9AD`, Muted `#6E7176`, Hairline `#34373A`, Emerald `#2DB47D` (primary). Neutral surfaces carry no visible green cast; the primary supplies life.
- **Light handoff.** Ground `#FAFAFB`, darker rail `#EFF0F2`, Raised `#FFFFFF`, Ink `#222429`, Soft `#60636A`, Muted `#95989F`, Hairline `#D7DADD`, Emerald Deep `#087653` (primary). Light-mode functional colors are deliberately deeper and more vibrant than muted pastel tints.
- **Functional handoff.** Tool colors are semantic and independent of primary: file-change counters and diff status stay green `#8BCF67` / `#3D7D14`, while `Edit` / `Write` / `ApplyPatch` headings use copper `#F09A5B` / `#A84F00`; deletion `#EC707B` / `#D12D49`, thinking `#52BFD0` / `#007F9B`, warning `#E2B64D` / `#966C00`, generic tool `#6D9BEC` / `#1D5ED8`, syntax `#DE7CA7` / `#B52B70` (dark / light). Bash remains terminal-neutral. Thinking supporting text is `#C1D2D5` / `#2F454B`. Outside the composer, model controls retain their violet identity through `--chip-violet-*`; inside it they are neutral instruments (Composer › Instrument row). Permission modes keep each provider's own color (`tone` in `lib/provider-modes.ts`, the hue users know from that CLI). Neither inherits brand emerald.
- **Landing typography** (not a desktop mandate): Schibsted Grotesk for display/body, JetBrains Mono for annotations. Desktop UI stays Inter until the new theme work decides otherwise.

Full spec: `packages/landing/DESIGN.md`.

## Theme philosophy

Cadencr ships with two brand defaults — **CadencR Dark** and **CadencR Light** — plus the established **Aurora**, **Dracula**, and **One Dark** alternatives. The brand pair owns first paint and system-follow behavior; alternatives remain opt-in and retain their existing palettes. Every additional theme expands the QA matrix and requires a complete semantic, editor, diff, and xterm palette.

**Composition model.** A theme is a `data-theme="..."` attribute on `<html>` backed by a `ThemeDefinition` in `packages/desktop/src/lib/themes/`. CSS owns the semantic UI contract; the TypeScript definition owns metadata, the picker swatch, the logo cut, and the complete xterm palette. `theme-cadencr.css` binds the brand pair, while the existing legacy theme selectors remain independent. A missing CSS token falls through to the shared default — never null.

**Resolution.** Theme ids are explicit and provider-neutral. Registration and system-follow resolution live in `src/lib/themes/registry.ts` and `src/lib/themes/system.ts`:

```
cadencr-dark  → CadencR Dark (default dark and first paint)
cadencr-light → CadencR Light (default system-follow light)
aurora        → Aurora
dracula       → Dracula
one-dark      → One Dark
```

**Chrome — the shape of a theme, not its palette.** Three structural traits travel with a theme as data (`chrome` in `theme.json`; `ThemeDefinition.chrome` for a built-in), because a theme duplicated from another one has to _look_ like it and not just be colored like it:

| Trait     | Values                    | What it decides                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chassis` | `flat` · `rail`           | Whether the page tucks into the sidebar rail as a raised card with a rounded top-left corner, sharing one continuous header band (CadencR pair), or sits full-bleed under its own header (everything else). Desktop only — below 768px every theme is flat.                                           |
| `tabs`    | `underline` · `segmented` | Whether the active pane tab is a hairline indicator or a raised pill in a recessed track.                                                                                                                                                                                                             |
| `texture` | layers                    | What is painted behind the app: a flat `base`, drifting blurred `halos`, an `image` from the theme's own folder, generated `grain`, and a `veil` that washes the field back down with `--background` so surfaces stay legible. The Frost pair is one instance of this vocabulary, not a special case. |

`applyThemeToDocument` publishes the first two as `<html data-chassis data-tabs>`; the texture is rendered by `<AmbientBackground/>` and laid out by `theme-chrome.css`, which must never contain a `data-theme` selector. A texture that declares a `base` also makes `:root` opaque and `body` transparent — required for `backdrop-filter` to paint at all.

The CadencR pair's _material_ (pane elevation, lamplight, machined wells, prompt chrome) stays theme-scoped in `theme-cadencr-material.css`: it depends on tokens only those themes declare, and it is a look rather than a structural choice.

**Chrome has colors, and they belong to the theme.** The token vocabulary has two tiers. The required set is the palette every theme defines in full; a short optional set — `--tab-track-bg`, `--tab-track-border`, `--tab-active-bg`, `--pane-border` — colors the shapes a theme opted into, and `theme-chrome.css` derives a fallback from `--foreground`/`--background` for any a theme leaves out. They are optional because most themes draw neither shape; they exist because without them the only way to recolor a segmented tab strip was to edit the app's shared stylesheet — a change no installed Cadencr can receive, applied to every theme at once. An unknown key is still an error: this widens the vocabulary, it does not open it. `--tab-active-shadow` and `--page-shadow` stay out, being `box-shadow` values rather than colors. Duplication carries whichever of them the source theme declares, which is how a copy of CadencR Dark keeps its tab colors and not just its tab _shape_.

**A theme folder explains itself, and answers back.** A user theme is edited in its own project, which in practice means an agent with `theme.json` open and nothing else to go on — and the document is self-describing for colors and opaque for chrome. Worse, the verdict on what it writes lands on a settings card it cannot see, so a theme could be declared finished while the app quietly refused to apply it. Four files beside `theme.json` close that loop:

| File                      | For                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THEME.md`                | The loop, the vocabulary, the bounds, and what a rejected file does. Leads with the check command.                                                                                                               |
| `theme.schema.json`       | The machine-checkable half; the document's own `$schema` points at it, so an editor completes and flags as you type.                                                                                             |
| `check-theme`             | Runs `cadencr-service check-theme` on this folder: the app's gate, on demand. Prints the settings card's own wording, exits non-zero when the theme is not applicable.                                           |
| `AGENTS.md` / `CLAUDE.md` | The boundary, in the files an agent loads before its first instruction: this folder is the whole theme, never edit the app's source, run the check, and _say so and stop_ when a request isn't expressible here. |

All of them are written on every open and excluded from the theme's git via `.git/info/exclude` — the schema generated from the same constants `validate` enforces, the prose held to them by tests — they are the app's, not the theme's. The command is deliberately not a second implementation: it calls `store::read_at`, the same function the gallery calls, so the two can never disagree. It needs no server, database or token, and the launcher is rewritten each open so its path follows the binary across rebuilds and updates.

Chrome additionally denies unknown fields, so a misspelled key is a reported issue rather than a silent default; the label is recovered from the raw JSON when the document won't deserialize, so that costs a message and not the theme's name. Bounds, variant lists and the reference's prose are guarded against drift by tests in `themes/schema.rs` and `themes/scaffold.rs`; a new chrome value belongs in `ThemeChassis::ALL`-style lists and in `THEME.md`, or those tests fail.

**Adding a theme.**

1. Add a complete typed `ThemeDefinition` under `src/lib/themes/`, including a full xterm palette and stable swatch.
2. Add the theme's semantic CSS selector without changing another theme's tokens.
3. Register it in `registry.ts`; the picker is registry-driven and must not hardcode a second list.
4. Extend registry and scrollbar contract tests, then verify editor, terminal, agent tools, diffs, onboarding, and system-follow behavior in the running app.

## Layout decision logic

The pane configuration is a single `tweaks.layout` value with four legal states. Every layout MUST be registered in (a) the `config` `useMemo` in the HTML file's `App` component, (b) the `cds-split` CSS rules in `kit.css`, and (c) the `TweakRadio` options in the Tweaks panel. A layout that is not in all three places is broken.

| Layout          | When to use                                                                                                                                                                                                           | Default for                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `single`        | All four tabs in one pane. Use when the viewport is narrow, when the user is reviewing one thing at a time, or as a fallback.                                                                                         | Unified agents (the cards already show many agents — no need for split panes inside a card). |
| `split`         | Two equal-priority surfaces — agent reasoning + one inspection pane. The classic IDE feel.                                                                                                                            | Generic "I'm doing one feature" sessions.                                                    |
| `split-stacked` | Agent gets the full left column. Right column is vertically split — Terminal top, Git+Editor bottom. Use when terminal output and the diff are both running hot and the user wants to glance at both without tabbing. | **Session view (`Page - Session.html`).**                                                    |
| `wide`          | Agent solo on the left, every other tool stacked into one tabbed pane on the right. Use for narrow secondary monitors or when the agent narrative is the main content.                                                | One-off; not a default.                                                                      |

**Session vs Unified agents.** Unified agents lands on `screen="unified"` and renders `<UnifiedAgentsView>` — a grid of agent cards. Session lands on `screen="workspace"` and renders the four-pane workspace. They share the same React component tree below the screen switch; the screen value is the only routing concept.

## Component anatomy

### AgentPanel (`<window.Panels.AgentPanel/>`)

The agent stream. A vertical scroll of mixed content: user bubbles, agent prose, code blocks, tool calls, thinking blocks. **This is the most important surface in the product** — every other pane is in service of what's happening here.

- **Structure:** `.cds-stream > [meta, bubble | section | tool, ...]` in document order.
- **Agent-sent messages:** a message another conversation's agent sent wears a sender tab on its bubble's top-right edge, in the bubble's own border and tint (they follow the delivery state); the right sides run on as one, the bubble keeps its top border under the tab like a folder tab and stretches to at least the tab's width. The tab reads: an `AGENT` eyebrow (10.5px semibold, tracked, muted), the sending conversation's mono provider mark + title (12px medium `--foreground`, truncated) as a button with a `--foreground` 10% hover fill clear of the muted time that ends the tab. It replaces the stream's "User · time" line. Hovering or focusing the title lights that conversation up in the sidebar; a click opens it.
- **States:** Tool calls have collapsed (single-line button) and open (expanded with diff/term body) states. The collapsed `.cds-tool` is a `<button>`; the open one is a `<div>`.
- **Tokens consumed:** `--background`, `--foreground`, `--primary-glow` (user bubble), `--ic-bg`/`--ic-fg` (mention chips), `--ic-file-bg`/`--ic-file-fg` (file refs), `--code-bg`/`--code-fg` (code blocks), `--diff-add-bg`/`--diff-del-bg`, `--tag-grep`/`--tag-read`/`--tag-bash`/`--tag-edit`/`--tag-think`, `--h-user`/`--h-agent` (section headings).
- **When to use vs alternative:** This is the only place agent reasoning surfaces. Do not duplicate.

#### Thinking block (sub-component)

A collapsible card with a theme-owned thinking tint distinct from the surrounding stream. The dedicated tint is the affordance — it tells the user "this is meta-reasoning, not output." Use `--block-thinking-accent` and `--block-thinking-bg`; in Emerald Reserve these are cyan, with separate supporting text chosen for contrast. **Never use `--primary` for a thinking block:** reasoning has its own semantic slot, separate from primary-action color.

#### MCP tool call

Same chrome as a regular tool call (`.cds-tool`) but the `.tag` element gets a colored prefix indicating provider. Body is monospace, file paths in cyan (`--ic-file-fg`), counts in `--acc-green`/`--acc-red`. Bash variant gets terminal-style chrome (`.cds-tool.open.bash`) via its own `--block-bash-header-bg` / `--block-bash-body-bg` / `--block-bash-fg` / `--block-bash-muted-fg` tokens, which follow the theme (dark on Dracula, light on Aurora). The live xterm still stays dark in every theme — see rule 10.

### TerminalPanel (`<window.Panels.TerminalPanel/>`)

Static terminal-style log. Always uses `--code-bg` and `--code-fg` regardless of theme — even Aurora's terminal stays dark. This is intentional: a terminal that flips to white-bg looks broken to developers.

- **Structure:** `.cds-terminal > div.line[.kind]`. Kinds: `cmd`, `ok`, `info`, `mod`, `add`, plain.
- **States:** Static. No interactive states.
- **Tokens:** `--code-bg`, `--code-fg`, `--acc-green` (ok), `--acc-yellow` (info/warn), `--acc-cyan` (urls + branch).

### GitPanel (`<window.Panels.GitPanel/>`)

Three rows: head (file path + +/- stats + Viewed checkbox), body (diff hunks), foot (file count + view mode toggle).

- **Structure:** `.cds-git > [.cds-git-head, .cds-git-body, .cds-git-foot]`.
- **States:** Body rows are `.add` / `.del` / `.unchanged` / `.ctx`. Foot toggle is Unified (default) or Split.
- **Tokens:** `--diff-add-bg`, `--diff-del-bg`, `--code-bg`, `--code-fg`, `--acc-green`/`--acc-red` for stats.

### EditorPanel (`<window.Panels.EditorPanel/>`)

Review-first two-column grid: 200px file explorer + writable code area with tab strip and footer. The Editor supports focused edits, including resolving Git conflict markers, through the existing save/auto-save and formatting flows. It is not the primary surface for broad code authoring. Syntax tokens (`tok-kw`, `tok-str`, `tok-type`, `tok-prop`, `tok-comment`, `tok-num`, etc.) map to `--acc-*` accents.

- **States:** Explorer item active/dim. Editor tab active. Ordinary large files begin behind the existing `Edit anyway` safety gate before becoming writable.
- **Tokens:** `--code-bg`, `--code-fg`, `--primary` (active explorer item via 28% mix), `--acc-pink`/`--acc-cyan`/`--acc-green`/`--acc-yellow` for syntax.
- **When to use vs alternative:** Use Editor to inspect agent output, make a bounded correction, or resolve a conflict in the current worktree. Keep broad implementation work in the agent workflow or the user's dedicated external editor so Cadencr's product posture stays review-first.

#### Conflict resolver

The conflict resolver is an Editor mode for one unmerged worktree path. It reuses the existing tab, theme, dirty-buffer behavior, Save ownership, auto-save/Mod+S, and review-first posture rather than creating a separate editor surface. It must read as a **native CodeMirror file edit, not a bespoke conflict dashboard**.

##### Activation and anatomy

- Opening a path that backend-confirmed Git status reports as an exact unmerged file activates the resolver automatically — there is no "Resolve in Editor" step. Watcher-confirmed resolution returns a clean tab to the ordinary editor. A dirty Result keeps only a small exact-path latch in its pane, so switching to another tab and back cannot replace unsaved conflict edits after status clears; the latch disappears when that path is no longer dirty. Ordinary files open normally, and no Git state is mirrored into editor tabs.
- No resolver header, footer, or comparison toolbar. There is exactly **one writable `Result` `EditorView`**; conflict regions and per-hunk actions live inline in CodeMirror. The Result is the whole surface — the tab strip already names the file.
- The existing file-content endpoint supplies the worktree Result plus binary, large-file, and missing-content metadata. The resolver parses literal Git marker blocks directly from those Result bytes; it does not request Base/stage documents or a presentation/fingerprint contract.
- Current vs Incoming marker regions are rendered as color-coded inline decorations (theme-owned cyan for Current and violet for Incoming, distinct from the reserved add/green and delete/red diff colors). A diff3 `|||||||` Base section, when present in the Result, receives a muted inline decoration but is not a separate document or accept source. There is no source-comparison picker, self-comparison view, or CodeMirror merge extension.

Operation-aware marker labels drive the inline accept actions (never generic Current/Incoming during rebase):

| Result marker side             | Merge label     | Rebase label    | No operation context |
| ------------------------------ | --------------- | --------------- | -------------------- |
| Current (`<<<<<<<` to divider) | Current branch  | Rebased result  | Index stage 2        |
| Incoming (after `=======`)     | Incoming branch | Replayed commit | Index stage 3        |

Supported text hunks offer `Accept Current branch` and `Accept Incoming branch` during merge, `Accept Rebased result` and `Accept Replayed commit` during rebase, plus `Accept both`. They edit only `Result` as one undoable transaction, dirty the buffer, and never Save or Stage immediately. `Accept both` applies stage 2 before stage 3. If a hunk no longer maps safely after manual edits, its action row is replaced inline by a short reason and manual editing is preserved rather than guessing.

##### States and actions

- Binary, both-deleted, unsupported, unavailable, and deleted worktree Results use explicit guidance instead of fabricated empty source panes. Confirmed deletion conflict kinds offer `Stage deletion`; other unavailable Results require repository inspection before staging. Large text Results use the same one-buffer marker resolver: the single-file fetch already returns the explicitly opened content, and the resolver runs no source-comparison diff.
- Save writes only `Result` bytes to the worktree and continues to show that staging is required. Stage is explicit, and the conflict UI remains until watcher-confirmed status removes the unmerged path.
- The per-file Git banner owns explicit `Stage` and watcher-confirmed resolution; the operation-wide banner owns Continue and Abort, and Continue stays disabled until every conflict is staged. It is state-aware: while conflicts remain it wears the warm `--acc-orange` "paused on conflicts" identity, and once every conflict is staged it flips to the `--acc-green` "ready to continue" identity with Continue enabled — the two accents follow the documented in-progress/ready status semantics. Continue and Abort read as the operation Git itself is running (`Continue merge`/`Abort rebase`), never the internal "update" wording. The per-file banners stay visually subordinate to this one command bar — a quiet accent stripe rather than a stack of repeated alarm bands.
- Loading, failures, and actions have visible progress or error states. Action groups are keyboard reachable with clear focus, disabled actions explain why, and updates use one polite status region.
- The resolver is for bounded review and conflict resolution, not general three-way authoring.

### Sidebar (`<window.Sidebar/>`)

268px fixed-width left rail. Header (traffic lights + brand + dev pill) → All-agents nav button → Projects scroll area → Settings footer.

- **Structure:** `.cds-sidebar > [.cds-sidebar-header, .cds-sidebar-nav, .cds-sidebar-scroll, .cds-sidebar-footer]`.
- **Project group:** `.cds-project-group > [.cds-project-row, .cds-feature-list]`. The feature list has a left rail (`border-left: 1px solid var(--sidebar-border)`).
- **Three levels:** sections, projects and conversations must read apart at a glance. Each section (For me, Pinned, Projects and the other blocks) opens with a hairline divider (`--border` at 60%) and its eyebrow; a block's counter is a small pill (`--foreground` at 8%, 10px tabular numerals). A project row is 14px medium text at 85% `--foreground` (full when active or hovered) led by its logo, else its color dot. Its conversations hang one step in, on a 1px guide drawn under the project's chevron (`.sidebar-project-children`: `--border` at 60%, `--foreground` at 22% for the open project). The rows' twisty column sits on that guide rather than taking a column of its own; rows inside a worktree group keep theirs, inside the group's box.
- **Active feature:** `.cds-feature-row.active` gets a `--primary` 18% mix bg + a `.cds-active-rail` 2px primary bar at left:-11px.
- **Worktree group:** conversations sharing one worktree are banded into `.worktree-group` — a `--sidebar-border` rim plus a 5% `--sidebar-foreground` wash. This is the one sidebar surface that does _not_ take the neutral `--accent` wash: `--accent` is spoken for by row hover, and a group must never read as a hovered or selected row. The rim carries the grouping; the fill stays below the hover tint. Palette tokens are unusable here — `--muted` equals `--sidebar` in CadencR Light.
- **Conversation row:** a stable 24px title line (including hover/focus), a fixed 14px leading status slot, optional worktree marker, truncating title, then a 16px identity/shortcut slot at the far right of the first line. Metadata stays below; pin/archive actions appear on hover, keyboard focus, or touch devices instead of reserving empty columns. An idle conversation's title steps back to 70% `--foreground` (full again on hover or focus); the open one and any that is working, waiting, failed or unread keep full contrast.
- **Pull request chip:** the meta line's PR/CI slot names the current branch's pull request (else another branch's) by number in its tone, plus a `+N` in the most urgent tone for the conversation's other open ones. Its tooltip gives every one of them its own line: tone dot, mono `#number`, the branch name's last segment (muted mono), then what stands between it and its merge. A click opens that pull request in the conversation's Git tab: the conversation, the Git tab focused, its PR view, that proposal's tab — without the row navigating on pointer-down first.
- **Provider mark:** always a quiet mono silhouette, never animated or status-tinted. Normalize bundled marks to a 14px longest ink edge, compensating for transparent canvas padding in provider metadata. The Provider display option (logo · logo + model · hidden) changes branding only; "logo + model" adds the model id as 10.5px muted mono text on the meta line, so it never squeezes the title. Holding Command (macOS) or Control (Windows/Linux) replaces the mark with the numeric navigation hint in the same slot.
- **Display options:** one popover (sliders button in the Projects header, opens to the right, 24rem, scrolling within the window height) and the Settings → Sidebar section edit the same typed `sidebar_*` settings, applied live; Reset clears them all. Both lay the options out under the presets in the same groups (Essentials, Rows, Blocks, Organize, Attention, Collapsing & filter); the popover shows Essentials and folds the other groups behind a full-width header with a rotating chevron. In the popover, each option's name is muted text that brightens on hover and explains itself in a tooltip (the Settings page prints the same text under the row); values whose label isn't enough carry their own tooltip in both places. Density sets the row's block padding around the 24px title line: compact 28px, comfortable 36px (default), spacious 44px per single-line row, project rows included (a project row always reserves its 24px hover actions, so revealing them never shifts the list). Text size is 12 · 12.5 (default) · 13 · 14px. Titles take one truncated line (default), two clamped lines, or wrap in place on hover/focus; in the last two modes the fixed slots stay on the first 24px line. Density, text size and title mode are attributes on the sidebar root read by `sidebar-rows.css`, so rows never re-render for them. Every meta element (label as chip or dot, branch, diff, PR/CI, shells and tabs, ports), the worktree marker and the title source (title · branch · folder) can be switched; a meta line with nothing left to show does not render.
- **Display options preview:** while the popover is open the sidebar shows sample conversations instead of the user's (fixtures in `lib/sidebar-sample-data.ts`: every status, a pending permission and question, worktrees, labels, diff, PRs (one with failing checks, one approved and green, so For me shows every verb), ports, a child conversation, idle ones old enough to fold, a long title, a folded project; each project carries a made-up logo, inline SVG in `lib/sidebar-sample-logos.ts`, so the preview reads like a real workspace), rendered by the same `FeatureRowBody`, `SidebarBlock` and rail tiles as the live sidebar; the few hooks that read by id (project color and logo, pending request, gate popover) answer from `SidebarSampleContext` and never fetch. A single tinted line above the blocks (`--primary` at 7% with a 25% rim and a primary dot) says so, with an icon-only Replay (every sample goes back to its previous state, then reaches its own again: rows flash, the newest request's popover opens per the Gate popover option) and Show mine / Show samples (remembered until the app restarts). Using the preview or its popovers keeps the display options open; answering a sample request sends nothing. Settings → Sidebar lays the options out as one card per group with the group's name above it, and shows the same preview ("Live preview", the Projects header named and iconed as the current lens) as a sticky 16rem column beside the options (above them below `lg`), with the collapsed rail laid sideways under it; in a card narrower than 36rem the controls go under their description. Pointing at or focusing an option outlines what it changes (`data-sidebar-highlight` on the sidebar root and the preview, rules in `sidebar-rows.css`), in a 75% `--primary` hairline.
- **Lenses and views:** the Projects header's name is a menu: "Group by" (the `lens` option: project · status · worktree · provider · label · date · flat list) and the saved views. Every lens but project replaces the tree with one virtualized list of every project's conversations (`/api/features/active`): group headers in the project-row style (chevron, name, count; they fold, in memory) over the block rows, each with its project's color. Status groups go waiting → failed → working → unread → idle; date groups go Today · Yesterday · This week · Older; worktree, provider and label groups follow their newest conversation, the "none" group last. Like the tree, a lens leaves pinned conversations to the Pinned block. A saved view (Settings → Saved views: a name and a query in the Agents grid filter language plus `/status:`, `/label:`, `/provider:`, `/worktree:`) shows its matches as a flat list until a grouping is picked again. "Sort conversations" (activity · created · title · manual) orders rows within a project or group; "Sort projects" is frozen (by activity, re-sorted with the header's refresh button, the default), live (by newest active conversation) or by name — the refresh button only shows when frozen. With "Sticky headers" (default on), an expanded project's row and the group at the top of a lens list stay pinned to the top of the scroll area. A header in its place reads as a plain row; only once stuck (`.sidebar-sticky`, a `scroll-state` container) does it take an opaque fill (the sidebar color over the app background forced opaque, since frost themes make both translucent) and a soft shadow on the rows passing under it. The lens list's overlay header always wears that fill (`.sidebar-sticky-fill`). The Projects header's name carries its lens's icon (a bookmark for a saved view).
- **Manual order:** dragging a conversation row (or ⌥⇧⌘↑/↓ on the focused one) reorders it among its own group's rows only: a worktree group's, the flat list's, one parent's children, Dormant's, Pinned's, or one lens group's (a saved view with its own `/sort:` doesn't reorder; For me, In progress, Recent, archives and the preview never do). One rank (`sidebar_conversation_order`) orders every group, so the tree, Pinned and every lens agree; conversations it doesn't rank yet show first. The first drop under another sort switches "Sort conversations" to manual, seeded with the order on screen so only the dragged row moves; picking another sort keeps the rank for later. While dragging, the drop point is a 2px `--primary` line across the gap above or below the hovered row, the dragged row steps back to 45% opacity, and rows outside its group refuse the drop (not-allowed cursor). Rows move once the write is saved, sliding into place.
- **Time:** last activity (else creation), relative (`now`, `5m`, `3h`, `2d`, `3w`, `2mo`, `1y`: never wider than four characters) or absolute (clock time today, else the date), 10.5px muted tabular numerals at the end of the title line. Hovering or focusing the row swaps it for the row actions; one shared minute clock drives every label.
- **Local filter:** typing a printable key while focus is on a sidebar row opens a filter field above the Pinned section (Escape clears it and returns focus to the row, ↓ enters the results, Enter opens the first). It matches titles, labels and branches; projects with no match hide, projects with matches are held open on them (the whole project when its own name matches), pinned rows filter in place, archives stay out.
- **Conversation status:** distinguish activity from a finished, unread response by both shape and color: a blue rotating 12px open ring while working, a steady green 14px check for unread messages once idle, an amber permission shield, a primary question glyph, a red 14px alert circle with the pending halo when a turn failed while nobody was looking, and a muted idle dot once read. Pending indicators retain the existing interactive gate popover. Reduced motion and disabled animations stop rotation; the open ring remains distinct from the check. A check means a response is ready to read, not that its task or tests succeeded. One derivation (`deriveAttention()`: pending request > unseen failure > working > unread > idle) feeds the slot; a parent whose subtree is collapsed shows the most urgent state among its hidden children, and its gate popover answers that child's request. Failure and unread are per-window marks that clear when the conversation is opened; "Mark as unread" (row menu or ⌥⌘U) sticks while the conversation stays open. The "dot" style swaps the shapes for 8px color dots (working blue and breathing, unread green, failed red, idle muted 6px); "hidden" empties the slot except for a pending request or a failure, which always show.
- **Pending request line:** a waiting row names what it asks for under its title ("Bash: pnpm test", the question itself), 11px, `--acc-yellow` for permissions and primary for questions, truncated with the full text on hover; a 12px skeleton holds the line while it loads. Switchable as the "Pending request" row element.
- **Two badge levels:** what needs an action (a pending request, a failure) is a strong filled pill, amber or red, with dark numerals; what only informs (agents at work, unread replies) is a quiet 6px mark, blue and breathing or green, with muted numerals. Collapsed project rows end with these badges (count · dot · none), swapped for the row actions on hover or focus.
- **For me:** a block above Pinned listing the user's next actions across projects, one row per conversation under its most urgent action: answer a pending request, look at a failed turn, fix a pull request's failing checks or address its requested changes, review a finished reply, merge an approved pull request with green checks (`deriveNextActions()` in `lib/next-actions.ts`). Each tier lists oldest first; a conversation whose agent is at work stays out. Each row keeps its title line whole and names its action on an 11px line under it (`SidebarNextActionLine`), in place of the pending request line: the verb, then what it is about in muted text (the request itself, the pull request number and its first failing check). Verbs: "Approve" (permission or plan) and "Respond" in amber `--acc-yellow`, "Answer" (question) in `--primary`, "Check error" in `--acc-red`, all semibold; "Fix CI", "Address review", "Review" and "Merge" in medium weight at 75% `--foreground`. The line shows in every density, compact rows included: naming the action is the block's point. The first 3 or 5 actions show (the "For me shows" option, or all), then a quiet 11px "Show N more" / "Show less" line that ↑/↓ reach. ⌘J walks the same list, carrying on from where an opened failure or reply left it. An entry leaves the list once handled; "For me clears" says when a review or a failure counts as handled: on open (default), or "When done", where it stays, open or not, until the user marks it done or sends the conversation a prompt (a turn that ends while viewed then waits in For me too). Marking done is the row's hover check (a 24px ghost icon button with the row's other hover actions, absent on pending requests, which stay until answered) or ⌥⌘↩ (the focused row, else the open conversation); it also dismisses the row's pull request action until the pull request's head moves (`prActionKey`). Marks and dismissals persist per client in localStorage, across restarts. Same eyebrow as Pinned with an inbox glyph and a count of every action, collapsible, capped at 40vh with its own scroll, hidden when empty or while filtering. When a waiting conversation shows in several places only one gate popover auto-opens: the rail when the sidebar is collapsed, else For me, else the tree; the tree also takes it when the newest request sits behind "Show more"; a collapsed sidebar without a conversation rail auto-opens none.
- **In progress and Recent:** two optional blocks under For me, same eyebrow: "In progress" (loader glyph) lists every agent at work across projects, longest running first, and loses a conversation as soon as it asks or finishes; "Recent" (history glyph) lists the 3, 5 or 10 conversations touched last (latest message sent, else created), newest first. Both fold from their header and hide while filtering.
- **Block headers and empty blocks:** For me, In progress and Pinned headers end with a counter (count · dot · none); the dot is amber when something needs an action, muted otherwise. With "Hide empty blocks" off, an empty block keeps its header and says so in one 11px muted line ("Nothing waiting on you", "No agent at work", "Pin a conversation to keep it here").
- **Flash on change:** a row, or a rail tile, whose conversation starts waiting, fails or gets an unread reply flashes once: a 22% wash of the state's color (amber, red, green) fading out over 900ms. Never on mount; disabled animations skip it.
- **Pointed conversation:** pointing at a conversation from outside the sidebar (an agent-sent message's sender in the stream) lights up each of its rows in place: a 14% `--primary` wash and a 1px 55% `--primary` inset rim, quiet title brought forward, no scroll and no layout change. It lasts while the pointer or focus stays on the reference.
- **Gate popover:** opens by itself on the newest pending request (auto, default), after a 150ms hover on the pending icon (hover; it closes 250ms after the pointer leaves both icon and popover), or only on a click.
- **Auto-collapse:** when on, a window narrower than 1024px folds the sidebar to its rail without storing it; expanding it by hand wins until the window widens again.
- **Dormant:** top-level conversations idle for longer than the configured days (3 · 7 · 14 · 30, default 7, or never), spawned children included, fold under a quiet "Dormant" row styled like "Archived": its chevron in the rows' status column (clear of the project's guide), the name, the count at the far right. The open conversation and any that is working, waiting, failed or unread never fold. Purely visual.
- **Collapsed rail:** collapsing the sidebar leaves a 48px rail (desktop only) on `--sidebar`, the expand button at its top (below the macOS traffic lights) and Settings at its foot; it is the only place for both, so the page header carries no brand or sidebar actions. Collapsing never changes a page header's height (the expanded header is the reference): on macOS the traffic lights move instead, centered on the header row they now sit beside (measured live, re-placed when that row resizes or the zoom changes), and the page title starts about 20px after them. The rail's top band matches the expanded sidebar header (72px on macOS) and its hairline starts under it; in the `rail` chassis the band is seamless and the page keeps its tucked corner. With the rail set to "None" the header takes expand and Settings beside the traffic lights instead. Tiles are tinted with their project's color (`.sidebar-rail-tile`: 30% rim, 14% fill, the glyph in the color pulled toward `--foreground`; stronger on hover and when active). "Projects" shows a 32px tile per project with its logo, else its initial, a 2px ring in the most urgent state's color and a corner pill counting what needs an action; clicking expands the sidebar on that project. "Active" shows a tile per conversation with something going on (its initial, tinted like its project), "Attention" only those waiting, failed or unread; each tile carries the row's status glyph in its corner, so a pending request is answered from the rail. "None" keeps the zero-width collapse. Tooltips open to the right.
- **Presets:** both layouts read as two numbered steps (`SidebarConfiguratorSteps`: a 16px `--primary` 15% disc with the number, the step's name, a muted detail): "1 Preset — The base every option starts from", then, past a hairline, "2 Adjust — On top of <preset>" heading every option group, so a preset reads as the base the options modify, never as one more option. Step 1 is four cards, each a 2px-bar sketch of the sidebar it makes (`SidebarPresetSketch`, a project and three conversations — working, waiting, idle — drawn from the preset's own config, so it never drifts), its name and a few-word intent. One per way of working, deliberately far apart: Classic ("Balanced defaults", the defaults), Focus ("Only what needs you": dot status, no times or provider, compact rows that grow back when waiting, dot counters, no flashes, idle folded after 3 days, attention rail), Supervise ("Many agents at once": model, last reply and todo progress, In progress block, git details hidden, active rail, idle folded after 3 days), Detailed ("Every worktree detail": compact 12px two-line titles, branch, details on their own line, absolute times, Recent block). The matching card takes a `--primary` rim, 7% wash and a check, and the line under the grid repeats its description. Once an option moves, no card is checked: the nearest preset's card gets a dashed `--primary` rim and the line becomes a dashed status strip ("Custom · Supervise with 2 changes", "Back to Supervise"). Picking one rewrites every display option at once (behaviour switches such as type-to-filter, reveal, gate popover, auto-collapse, grouping and sorts stay as they are); applied over customized options, it offers Undo in a 10s toast. Settings lays the cards four across (two in a card narrower than 36rem), the popover two by two.
- **Tokens:** `--sidebar`, `--sidebar-border`, `--accent` (hover bg), `--primary` (question/active), `--muted-foreground` (eyebrows, idle, mono marks), `--sidebar-foreground` (text + worktree-group wash). Sidebar working retains Tailwind `blue-500`; finished/unread uses `--acc-green` (ready); permission retains `amber-400`; failure uses `--acc-red` (danger).
- **When to use vs alternative:** The sidebar is global navigation. Per-pane navigation goes in the tab strip, not here.

### TopBar

52px-min-height bar above the split. Owns the feature title, the theme switcher, the new-action button, and the settings gear.

- **Structure:** `.cds-topbar > [.feat-title, .cds-top-actions]`.
- **Tokens:** `--background`, `--border`.

### Composer (PromptBar)

The instrument the user plays all day — not a chat box. It answers four questions at a glance: what the agent will receive, where it will write, how much it may do on its own, and what Enter does right now. Lives in the root pane only — never duplicate it in a floating pane. Code: `components/AgentPromptBar.tsx`, `components/composer/`, `composer.css`; the CadencR pair adds its material in `theme-cadencr-material.css`.

- **Anatomy, top to bottom.** **Queue rail** (prompts queued for after the turn, stacked on the card's top edge: send now · edit · remove; a failed delivery stays with its reason) → **card**: launch manifest (first prompt only) · session header (only when one row runs out of room) · context tray · editor · instrument row.
- **Launch manifest.** One editable sentence before the first prompt: "Runs in [New worktree] from [main] · branch `feature/…` named from your prompt". The two tokens are the branch/worktree pickers in their `manifest` variant (no chip chrome, worktree modes keep `--chip-worktree-fg` ink). Isolation is the default for a new conversation; "Project folder" is a legitimate choice and carries no warning. Disabled worktree modes explain why.
- **Context tray.** Everything sent beyond the text, as removable chips (`--muted` wash, hairline `--border`): images and files with their names, long pastes (≥40 lines or ≥4 000 chars become a chip), editor selections and terminal output (⌘⇧↵ / Ctrl+Shift+Enter in those panes), review comments, a pull request. Suggestions (pending review comments, a PR link of this repo) are dashed chips with an explicit Attach.
- **Instrument row.** No chips: every control is a plain `composer-instrument` (neutral ink, a 7% `--foreground` wash on hover/open), and color lives only in icons — the mode in its provider tone, the provider's own model icon, a lit `--acc-yellow` bolt for Fast, the access mode's icon. Hairlines (`--border`, 14px) separate the groups: auto-scroll │ mode │ model · effort · fast │ access / session config — auto-scroll opens the row, on the transcript's side, and stays on narrow cards. Trailing: compaction hint, context meter, todos, history, ⋯ menu, attach, run controls. Nothing floats above the card. No icon appears twice in the row: Fast owns the bolt, access modes the shield family (Default `Shield`, Auto Review `ShieldCheck`, Full Access `ShieldOff`), a Default/Build mode the hammer, and auto-scroll double chevrons (`ChevronsDown` — an arrow onto a line reads as "download"). One size for every instrument: 28px tall (36px on touch), icon-only ones square, icons 14px (`size-3.5`) and disclosure carets 12px (`size-3`) — attach, Send, Stop and Steer included, never taller than the rest. Below 30rem the mode keeps its icon (square) and the context bar hides (a bar-only meter stays); below 26rem effort/Fast drop their labels; below 20rem secondary instruments (history) step aside.
- **Two rows: a session header.** When the instruments no longer fit one row at full labels — a split pane, zoom, a long model name, Stop + Steer appearing, a phone — they split by meaning, never by measured widths, so the card always reads the same. Atop the card (under the launch manifest before the first prompt), the **session header** says how the agent runs: mode │ model · effort · fast on the left, access / session config (ACP) on the right. Under the editor, the row about this conversation and this message: auto-scroll on the left, then compaction hint, context meter, todos, history, ⋯, attach and the run controls on the right — that cluster never leaves the bottom right corner. Below 30rem the card stays on two rows, so narrowing a pane goes one row → two rows → two compact rows, never back to one cramped row; it folds back to one row only with 8px to spare. Instruments move without remounting: an open picker stays open and focus follows the control.
- **⋯ menu.** One level: a click shows the session details directly (provider, MCP servers, profile, session id, launch command, sync from CLI — what the old Info chip held), with a "Keys & syntax" footer that swaps the panel to the composer's grammar (and back). Before a session exists it opens on the keys.
- **Ask on the side.** The virtual skill `/cadencr:side <question>` (Cadencr logo in the slash menu, never MCP-gated): the composer routes it to a new read-only conversation instead of the agent, so a running agent is neither interrupted nor shown it. That conversation is temporary (born archived, seeded without the transcript's charts, visuals and diagrams): it answers in a **side question** tray stacked on the card's top edge like the queue rail (`--muted` wash, hairline `--border`), streaming in summary form, with **Keep as thread** (un-archives it, lists it in the sidebar, opens it) and close (stops a working side agent). It never leaves the composer's draft behind.
- **Context meter.** Clicking cycles how it reads — bar + %, %, used / window, tokens left, bar only — a global setting (`composer_context_meter_display`). Hover card: "Context window" with the percentage large in the gauge tone (green → yellow → orange → red at 50/80/90%), a 20-cell gauge, Used / Free / Window, a one-line verdict, a note once compacted, and which reading is shown.
- **Run controls.** Idle: Send (+ chevron: schedule). Running: a labelled square **Stop** (never a pause glyph) and **Steer** — or **Queue** when the provider can't take mid-turn prompts (`steering_acknowledged`). Esc never stops on one press: the first arms (`Press esc again to stop`), the second stops; an open popover always owns Esc.
- **States.** Focus-within: border `--composer-focus-border` (a whisper of emerald, like a focused pane — no glow). Running: a thin `--primary` reflection crosses the card's top edge left to right, then rests (1px, 28% of the edge, 75% opacity with a 6px halo, 4.5s cycle — the crossing takes 55% of it; the track stops short of the rounded corners and fades at both ends). It reads at a glance and is forgotten while reading; under reduced motion it rests, faint, at the edge's middle). The placeholder states what Enter does now ("Describe the task…", "↵ to steer the agent at its next step, ⌘↵ to queue it after this turn"): one verb per key, never a dash to parse; phone variants cite no keys.
- **Popovers.** `@`, `@@` and `/` share one shell (`ComposerPopover`): it rises from the card's top edge at the card's width, groups options under quiet 11px labels, states its keys in a footer, and is a `listbox` the editor points at with `aria-activedescendant`. Only the highlighted command slides its long description.
- **Transcript markers it drives.** "Stopped by you · Resume" (persisted `turn_interrupted`) and plain-language errors with Continue / Switch model on the turn that just ended, raw text under Details.
- **Tokens:** `--card`/`--border` (card), `--composer-focus-border`, `--composer-radius` (`--radius` + 2px), `--primary` (send, running sweep), mode `tone` (provider colors), `--chip-worktree-*` (manifest), `--acc-yellow` (Fast, warnings), `--acc-orange` (compaction hint).

### Mode risk scale

Each mode declares a provider-neutral `risk` in `lib/provider-modes.ts`; the mode menu shows it as a gloss, while label and icon keep the provider's own color (`tone`), so the composer never contradicts what the user knows from the CLI.

| Risk     | Meaning                      |
| -------- | ---------------------------- |
| `read`   | Read-only (Plan, Ask)        |
| `ask`    | Asks before acting (Default) |
| `edits`  | Edits without asking         |
| `auto`   | Acts on its own              |
| `bypass` | No guardrails                |

The amber of "action required" is never used for a mode. Mode changes — menu, click or Shift+Tab — flash the control and are announced in an `aria-live` region; a mode the model can't hold shows a `--acc-yellow` warning with the reason.

### Worktree row

A single-line subtitle under the feature title, inside the TopBar's title block: disclosure chevron (under the project badge) + branch icon (on the title's left edge) + branch + clipboard chip + status badge. It never adds a band of its own, so on desktop the TopBar keeps the same height with or without a worktree and still lines up with the sidebar header. The chevron shares the project badge's grid column, so it stays centered under a dot or an icon. The expanded setup details (steps, log, retry) open below the TopBar, above the pane tabs. Uses `success` for the ready state — never warm-orange or accent.

### Branch chip (TopBar, right side)

Names the branch **checked out** in the conversation's directory, always (mono 12px, truncated at 160px): branch icon + name + a 6px dot in that branch's pull request tone (`PR_TONE_DOT`) + a `+N` mono badge counting the conversation's other branches (bordered muted; `--acc-red` border and text when one of their open pull requests fails its checks). The target is not in the chip: hover shows `branch → target` as the native title, a click opens the branch panel. A checkout that is not one of the conversation's branches (a worktree-free conversation whose project moved on, or the trunk) still names itself, in muted text and without a dot. On phones the chip moves into the Git actions popover, and the popover's trigger names the checked-out branch (mono, truncated at 96px) in place of "Git".

The panel (26rem popover, aligned to the chip's end) lists every branch of the conversation, current first on a 30% `--accent` wash with a bordered "current" tag: name, how it joined (original · agent · checked out here · linked · follows checkout, muted 10px), `→ target` (a mono button that swaps the list for the branch picker in place, with a back arrow), `↑ahead ↓behind` for the current branch, and its pull request line (tone dot + label, opens on the host). When the checkout is not one of them it heads the list as a plain row: name, a bordered "checked out" tag, "Not one of this conversation's branches", and a ghost `Link` button (none for a detached HEAD). A hover-revealed × unlinks a discovered branch; the original branch and a followed checkout have none. A shared worktree is a `--chip-shared-worktree-fg` note above a ghost "Link a branch…" footer. The panel never switches branches: a worktree-free conversation shares the project's checkout.

### Commits (Git sub-tab, graph view)

Answers "what is in this branch, and what is still only on my machine?". A 36px header names the branch (mono, medium) `→` its target (mono, muted) and, for the feature's own history only, where it stands against the remote: `↑ N not pushed` in `--acc-orange` medium, `↓ N to pull` in `--foreground`, or a muted `✓ All pushed`. It reads `ahead_of_remote` / `behind_remote` — never `has_remote`, which means "a forge host was recognized", not "a remote exists". Each 46px row leads with the commit message (12.5px `--foreground`; a merge steps back to `--muted-foreground`), then its refs; the meta line below is 11px muted: mono short sha · author · age · files · numstat. Refs are typed chips (18px, mono 10.5px, one 10px glyph): checked-out branch in a `--primary` 12% wash first, local branch on `--secondary`, remote-tracking branch outlined with a cloud glyph, tag on `--muted` with a tag glyph; they take at most 45% of the line so the message truncates first, and past three they fold into `+N`. A local-only commit ends its row with `↑ Not pushed` in `--acc-orange` (the arrow alone below a 30rem pane, the words kept for screen readers) besides its hollow graph node; a pushed commit says nothing. The keyboard-active row takes the sidebar's grammar: an `--accent` wash and a 2px `--primary` rail. The list is a size container: below 26rem the author drops out of the meta line. An opened commit's header leads with its message, the short sha muted beside it. The history refetches on every confirmed push and whenever a history-bearing status field moves (branch, staged count, ahead/behind the remote or the target, an in-progress operation), never for working-tree churn alone. Ref chips and the row mark carry no native `title`: the row's hover card already explains the commit.

### Pull request tabs (Git sub-tab, PR view)

A conversation with pull requests on more than one branch gets a row of tabs above the PR view's status band: one per branch, the conversation's current branch first (with a branch glyph), then the others in the order the poller lists them. Every tab carries the same weight: tone dot (`PR_TONE_DOT`) + mono `#number` + the branch name's last segment (mono, truncated), 12px, 36px tall, on the band's `bg-card/40` with a hairline bottom border; the shown tab is `--foreground` over a 2px rounded underline, the others muted until hovered. A current branch without a pull request keeps its tab (glyph + branch name) and shows the "No open pull request" state. Picking a tab swaps the whole pane — band, checks, description, review threads — and is remembered per conversation; ←/→ move between tabs. A single pull request draws no tabs. The Git sub-tab's PR tab names the current branch's pull request and counts the others as `+N` in the most urgent one's tone. Opening a pull request on its host stays the band's `Open` button.

### Notch island (`src/notch/`, macOS only)

The "Notch" notification destination: transparent, click-through windows managed by `electron/main/notch-window.ts`, each hugging its display's notch or drawing a virtual one at the top center. It continues a piece of hardware, so it is **always dark** whatever the app theme — it binds the CadencR Dark handoff values in `src/notch/notch.css` (`--n-*`), never the theme tokens.

- **Displays.** Settings → Notifications → Show notch on selects Built-in always (default), Both, or Primary. Built-in always falls back to the primary display when the built-in panel is disconnected. Both shows one island per distinct selected display. All instances use the same renderer, style, agent state, and notifications; each has its own cutout geometry and hover region.
- **Primary status.** A separate Primary display status selector controls compact activity on displays without a hardware cutout: No status, 4 px, 8 px (default), or Built-in notch style. It is disabled while Show notch on is Built-in always, with an explanation to choose Both or Primary; the saved style is preserved. No status hides compact activity and clears its hover region while preserving notification peeks. The full style reuses the native geometry, orb and compact dots. Hardware cutouts retain their native appearance regardless of this preference. Show notch on chooses where to display; Primary display status chooses how it looks. Always on controls compact visibility, with No status taking priority on virtual islands; Always animate controls motion on both thin strips and the full style.
- **Body.** Pure `#000` so it is indistinguishable from the cutout, with concave top shoulders where it meets the screen edge. It is drawn at full size and revealed by a `clip-path` driven by registered properties (`--iw`, `--ih`, `--ir`), so content never reflows while the shape springs; content only comes into focus (blur → sharp) once the shape lands. Growing uses `--n-spring` (one small overshoot); shrinking uses the plain ease-out.
- **Ears.** The band level with the cutout can only carry content left and right of it. Compact mode: the Index Dots orb (aggregate status; the plain logo while still) + one dot per agent that is working, waiting on you, or finished with an unread reply. Read, finished agents stay in the hover list but never hold the compact island out; once none of the others remain it tucks back into the notch. Peek: orb + status word. Panel: orb + `CADENCR` wordmark + at most two counts.
- **Virtual activity strips.** The 4 px and 8 px styles hug the top edge with bottom radii equal to half their height and concave shoulders extending 6px horizontally, drawn as one continuous outline without raster seams. Their fixed width uses half the built-in cutout's physical width, converted to the target display's DIP scale; without a built-in reference they use half the virtual notch width. Three 4px points use the running orb's blue comet color and opacity range (0.18–1), moving left → center → right → center → left on the left when Always animate is on. When the aggregate native orb would show its done check (unread replies, with no working or waiting agents), these three points are steady leaf green: the middle at full opacity and both sides at 0.5. Agent indicators are 4px circles, aligned right, with the existing status colors. Only working indicators pulse in opacity; waiting and finished indicators stay steady, matching the compact native notch. Reduced motion stops both loops. All virtual styles disappear when there are no agent status dots, including when every finished reply has been read; the hardware island contracts into its physical cutout. Strip hover regions match their height without vertical slack. Peek notifications and the expanded hover panel keep their existing geometry and design in every primary status style.
- **Index Dots orb.** The logo (≤32px cut) as status glyph: a comet chases the ring while an agent works, the ring pulses when one waits on you, and floods green while drawing a check when one is done.
- **Strip overflow.** Thin strips retain the first agents in the feed's attention order (permission requests, questions, unread replies, then running sessions). When their dots no longer fit, the strip reserves room for a `+N` count of the remaining sessions, including every digit, instead of clipping the urgent dots. The count uses the notch's muted monospace style at 4px in the 4px strip and 6px in the 8px strip.
- **Ambient calm.** The closed (compact) island is still by default: the status orb gives way to the plain Cadencr logo (ink dots, emerald core) on the left, and the per-agent status dots on the right hold still. Nothing in it moves — status lives in the dots' colors. The orb and its loops only come back once the island opens (peek or panel), unless the user turns on _Always animate_. With _Always on_ off, the compact state is skipped entirely: the island stays tucked into the notch between peeks and hovers.
- **Status colors** mirror the sidebar's leading indicator: working = blue, permission = amber, question = primary, done/unread = leaf green, error = red. The peek's light spill under the body takes the status color.
- **Rows.** Provider silhouette tile with a status badge, title + project, then one line: the last tool action in mono (with a sweeping mask shimmer while working) or a two-line plain-text preview of the last reply when done.
- **Snooze & close.** The panel's footer carries `Snooze` + 5m · 30m · 1h · 1h30 · 2h chips (muted pills on `--n-wash`); while snoozed it reads "Snoozed until <time>" with a `Resume` chip. A snooze tucks the compact island away and drops peeks (the Settings preview still shows); hovering the notch still opens the list. A peek held under the pointer grows a close button beside its title and the same chips under its body — closing drops that peek without opening the conversation. Snoozing or closing lets go of the island at once.

### Toasts (Sonner, `components/ui/sonner.tsx` + `toast.css`)

- **Placement.** In the sidebar, bottom-left: stacked upward from just above the sidebar footer (above the update pill when one shows, else above Settings), flush with the footer pills and as wide as them, so the stack never leaves the sidebar column. The footer publishes that anchor (`hooks/useToastAnchor.ts`). With the sidebar collapsed (or in the mobile drawer) they fall back to top-center, 16px under the top edge (plus the safe-area inset), 380px wide. Never bottom of the main area: the composer, the newest agent output and the terminal prompt live there. Below 600px they span the width at the top, under the safe-area inset.
- **Anatomy.** `--popover` card (sidebar-footer width, 380px top-center); at the narrowest sidebar a toast simply wraps onto more lines, hairline `--border`, `--radius`, a soft offset shadow (`--glass-shadow-overlay` in the CadencR pair, glass overlay material in Frost). A 24px icon well carries the variant: the Lucide glyph in the tone over a 14% wash of it — success `--acc-green`, error `--acc-red`, warning `--acc-yellow`, info `--acc-cyan`, loading muted. Errors and warnings also tint the rim (40% tone). No colored side stripe. Title 13px semibold; description 12.5px in `--muted-foreground`.
- **Scope line.** A toast about work that can finish while the user is in another project (a backgrounded commit or push, a git status failure, a notification fallback) leads its description with where it ran: the project's `ProjectBadge` (logo, else color dot, `xs`), the project name in 11.5px medium `--popover-foreground`, then `·` and the conversation title, muted, truncating first (`scopedToastDescription`, `components/ToastScope.tsx`). It is read from what is already loaded when the toast opens, never fetched afterwards (Sonner sizes a toast once); with nothing loaded the toast keeps its plain copy. Toasts answering an action in the open dialog or view stay unscoped.
- **Buttons.** Action is the `raised` button, cancel a ghost; 24px tall. A toast with a description or a cancel button moves its buttons to a right-aligned footer row (primary last); a one-line toast keeps its button inline.
- **Close.** Sonner's corner badge, shown on hover or focus; always shown (24px) where there is no hover.

### Marketplace (`/marketplace`, `components/marketplace/`)

The plugin catalog, shown in every build; a build with no compiled-in catalog feed says so once on the page ("The catalog isn't available in this build") with no retry. One sidebar entry above Agents, `Blocks` glyph, with a quiet primary dot + count of available updates; it is no longer a Settings tab (old `?tab=marketplace` links redirect).

- **Thesis.** A plugin is shown at the scale it lives at in Cadencr, never as a row of settings text: a theme as a miniature workspace (`ThemeStage`: sidebar rail, tab strip, thinking block, diff, composer) painted with the theme's own token values scoped to that box; a provider as the composer with its agent picker opened upward, this provider selected and its neighbours left blank (`ProviderStage`; tiles use its `compact` crop). Before a verified preview exists the stage is drawn in dashed outline only — the active app theme never stands in for unknown colors. Previews download and validate the archive without installing, so they run only on an explicit "Preview colors" click; installed themes paint immediately.
- **Custom tabs.** A schematic workspace tab strip with its name and a neutral `PanelTop` surface represents this contribution; it is not a preview of untrusted web content. Activation reuses the custom-tab permissions dialog. Installed marketplace revisions are separate from editable author projects.
- **Kinds.** A plugin kind is a category, not a status: its tone comes from the categorical chart palette (`--chart-2` themes, `--chart-4` providers, `--chart-3` custom tabs; a new kind takes the next free slot) through `.mp-kind-*` → `--mp-kind`. Kind chips are 20px pills (13% wash, 24% rim, tone mixed toward `--foreground`). Every listing renders `contributes[]` — one kind per package today, a multi-kind package needs no new layout. Filters and shelves show only kinds the catalog serves; never placeholder categories.
- **Marks.** Catalog entries carry no icon before installation, so the honest default is a monogram on the sidebar rail-tile grammar (kind tone at 14% fill, 30% rim). An installed provider shows its package icon.
- **Page.** Header like Schedules (glyph, title, "N plugins · catalog published 4 hours ago", Check for updates), then an underline lens Discover · Installed (n) · Updates (n, primary-filled count when > 0) with search at the right. Discover: the showcase band (copy left with the state badge in the chip row and the `0.1.0 → 0.2.0` delta beside its action, stage right; flat `--card`, no halo; pager, no autoplay) ordered by pending updates, then not installed — never an editorial "featured" pick; then type toggles with counts; then one shelf per kind (heading, count, one-line pitch, ≤ 8 tiles, "See all"). Filtering or searching switches to one virtualized grid. Tiles: 16:9 art over name, state badge, mono publisher · version, two-line description, kind chips; hover lifts 1px with a soft offset shadow.
- **States.** One badge per listing, most actionable first: Needs attention (destructive) › Restart to apply (`--acc-yellow`, the amber needs-action level — see Iconography) › Update x.y.z (primary) › In use / Active (primary dot) › Installed (muted check). Updates are detected only when the host's compatible recommendation is semver-newer than the installed revision — nothing is invented. Installed and Updates are one dense virtualized list (mark, name + kind chips, the mono `installed → available` version delta, then starts-with-Cadencr, install date, "Updated 9 days ago" — themes carry no dates and say nothing rather than a placeholder), with a direct exact-version Update button; Updates adds "Update all N" (sequential, stops at the first failure). Mono is for versions and identifiers only, never publishers or dates.
- **Detail page.** Breadcrumb header (Marketplace / Kind / Name). Hero: 64px mark, 26px name, chips + state, description, primary action derived from the chosen exact version, which defaults to a pending update so select, action and stage agree (Install x · Update to x · Change to x · a settled secondary "Installed"), version select, kind action (Use this theme / Enable–Disable); the stage beside it at 16:10. Below: Versions (selectable rows: recommended/installed tags, compatibility, platforms) and a dated History timeline (confirmed changes and quarantines), with a 320px aside of Details, Trust & safety, and Manage (duplicate theme into an author project; remove behind a confirmation dialog).
- **Feedback.** One activity panel under the header carries pending changes, confirmed results, catalog/inventory failures with their stable codes, and Retry / Reload theme state. A list/detail layout route owns the queries and mutations so in-flight work survives navigation.

### Unified agents grid (`/agents`, `components/UnifiedAgents*`)

Many agents at once, the ones that need the user first. Each card embeds a full feature session; `unified-agents.css` trims that session's chrome inside `.unified-agent-card` only.

- **Order.** An empty filter shows every active agent, sorted by attention — waiting on you › failed › working › unread › the rest — with pins, then latest activity, breaking ties (`/sort:attention`, the default). Any narrower view is a visible `/key:value` chip in the filter field; there is no hidden default window. The order is taken once per filter and then held: cards update in place, new agents join at the end, and a floating "N agents changed · Re-sort" pill offers the fresh order. Cards never move under the pointer.
- **Live.** Each card streams its own transcript. The list itself reloads (debounced) only when a turn ends or an agent the grid does not know starts, so times, new agents and order stay current without the Refresh icon; reading or failure marks never reload it, and reading a reply never raises the Re-sort pill.
- **Columns.** The stepper is a maximum. The grid shows as many columns as fit at a 400px minimum card width, never more than there are agents; a short last row keeps one column's width per card (a locked filler panel holds the gap, so cards are not remounted as the row fills). A row the user hasn't resized fills the grid height minus a 64px peek of the next row's header.
- **Card header.** Two lines. Line 1: status glyph (the sidebar's shapes — blue spinning ring, green check, red alert, amber gate icon, quiet dot), the title truncated only by the card edge, then icon actions pin · hide · open, whose tooltips read the live bindings. Line 2: project mark + name, a neutral label tag (never brand primary), the worktree branch glyph, and at the right either the state word ("Needs approval", "Has a question", "Failed" as soft pills; "Working", "Unread" as colored text) or the relative last-activity time. Waiting and failed cards also tint their rim (`--acc-yellow` / `--acc-red` at 50% into `--border`); the active card's primary ring wins.
- **Card body.** Narrow cards (< 560px container) collapse inactive tabs to their icon; the tab strip never shows the branch. The composer keeps its chips but drops the send/newline key hint. Auto-scroll is quiet while following (the normal state) and amber once parked.
- **Empty states.** No agents: say where they come from and how to start one (New, ⌘⇧N). No matches: "Show every agent" when a `/last` window is set, plus Clear filter. Load failure: the message and Try again.
- **Hide.** Hiding a card adds an `/exclude:` chip and raises an Undo toast.

### Command palette (⌘K, `components/CommandPalette.tsx` + `command-palette/`, `command-palette.css`)

The one place to go anywhere and find anything: conversations (archives included), projects, commands, settings sections, files of the open worktree and words said in any conversation. Opened by ⌘K and the sidebar's Search button; ⌘K stays the editor's and the terminal's own while they hold focus.

- **Shell.** One fixed-size box for every state (880 × 600px max, 12vh from the top), so typing, switching mode, opening actions or stepping into a flow never moves it. `--popover` on the app's dialog scrim, hairline `--border`, `--radius` + 2px, the theme's overlay shadow (`--glass-shadow-overlay` in the CadencR pair; Frost frosts it through `data-slot="dialog-content"`). Input row 52px (15px text), body = results beside a 340px preview, footer 36px.
- **Input row.** Leading search glyph, or a chip naming the mode or step (`Commands`, `Files`, `Messages`, `New conversation`, a project name, `Theme`, the acted-on title) in a 24px `--accent` pill. At the far end the scope button: Everything · This project · Active only (⌥S), outlined, taking a 9% `--primary` wash once narrowed.
- **Modes.** Typed first, `>` commands, `@` files of the open worktree, `#` words in prompts and replies (full-text, archives included). Backspace in an empty field or Esc steps out of a mode or a step; Esc at the plain search closes. The footer repeats the prefixes as buttons, the active one in a 12% `--primary` wash.
- **Empty state.** Needs you (the For me list, its verb at the row's end in the For me tones), In progress (agents at work), Recent (last activity or last palette pick, the open conversation left out so the first row is the one the user came from: ⌘K ↵ goes back), Suggestions. Typing replaces it with Conversations, Projects and Commands ordered by their best match, then Files and In messages, which arrive later and never shift the rows above them.
- **Rows.** 34px, one line, 13px, `--radius-sm`; selection is the neutral `--accent` wash, never primary. Conversation: 14px status slot (the sidebar's shapes; an amber shield for a pending request; an archive glyph for an archived idle conversation, whose title steps back to 58%), title, pin glyph, label pill, project badge + name (11.5px muted), relative time (10.5px tabular). Command: 16px glyph, title, the live binding as 18px key caps. File: file icon, name, directory in mono. Message: role glyph, the snippet with matched words in an 18% `--primary` `<mark>`, the conversation. Matched characters in titles take full `--foreground` at 600 weight against the row's 88%. Below 768px rows are 44px.
- **Ranking.** Words match in any order, accent- and case-blind, on a word start, inside a word, on initials of consecutive words, or as a tight in-word subsequence (`cmd`). Letters scattered across words never match. Title beats label, branch, project and provider; past picks (frecency, three-day half-life, per client), recent activity, waiting/failed state and the open project lift; archives sink but stay findable.
- **Preview.** The selected result in full: status and title, the next action and pending request lines, project, branch (mono), agent mark, label, times, then the agent's last reply (12 lines, skeleton while loading). Commands show their description and binding, files their first 40 lines on `--code-bg`, message hits the snippet and where it was said. Hidden below 768px.
- **Actions.** Tab (or the footer's Actions button, the only way on touch) lists what can be done to the selection, its Enter action first: open, pin/unpin, restore, mark as unread, new conversation in its project, copy title/branch/path. The preview keeps showing the acted-on result.
- **Flows.** "New conversation…" picks the project (open one first), then the working copy — new worktree, project directory, or any local branch typed to filter — and creates on Enter; the usual choice is marked "(usual)" and a different new/skip pick becomes the project's default. "Change theme…" previews each theme live as the selection moves and puts the active one back on Esc.
- **Commands are live handlers.** A shortcut listed in `palette-shortcut-commands.ts` registers its own callback while mounted and enabled, so the palette runs exactly what the chord runs and only offers what can run now. Never dispatch synthetic key events. A picked command runs after the dialog has closed and handed focus back, so a dialog it opens keeps the focus; closing without a pick restores focus to where it was.
- **States.** Loading conversations shows skeleton rows in place; a remote section shows a spinner line; errors stay inline in red where the rows would be. Nothing matched: the reason, then rows to look elsewhere (search messages for the words, widen the scope).

### Status dot

A 7–9px circle with a 2–3px halo (`box-shadow` 0 0 0 spread). Three legal slots:

- `--status-ip` (success/green) — feature in flight, "ready" worktree
- `--acc-orange` — "in progress" annotation
- `--acc-pink` (Dracula) — secondary project marker

The dot's color is the meaning. Do not introduce a fourth color without registering it as a status token.

## Iconography & status colors

- **Green dot** = ready (worktree set up, agent connected). Bound to `--status-ip` / `success`.
- **Theme-owned thinking tint** = thinking (agent meta-reasoning). Bound to `--block-thinking-accent` / `--block-thinking-bg`, never raw `--primary`.
- **Red counter** = retry / errors / -diff. Bound to `danger` / `--acc-red`.
- **Orange chip** = "in progress" / dev-pill. Bound to `warning` / `--acc-orange`.
- **Cyan path** = file reference. Bound to `info` / `--acc-cyan` (`--ic-file-fg`).
- **Pink chip** = mention / `@thing`. Bound to `--ic-fg` (`--acc-pink` in Dracula).
- **Amber pill** = an action is needed before something takes effect: a pending permission (sidebar) and a marketplace change that needs a restart ("Restart to apply"). Bound to `--acc-yellow`, always with its icon and verb so it never reads as the yellow CI chip below.
- **Yellow chip** = checks green, humans still waiting (a proposal whose CI reports passing and whose review threads are unresolved). Bound to `--acc-yellow`. Distinct from the orange "in progress" chip on purpose: nothing is running or failing, the ball is in the author's court. A repo with no CI at all keeps its check-driven chip — the count is only looked up for a reported pass, so "no checks" stays neutral rather than yellow.

**Semantic colors are token-owned.** Do not infer meaning from hue alone. Emerald Reserve intentionally uses green for brand primary while file changes use a distinct leaf green; components must consume `--primary`, `--acc-green`, `--acc-red`, and the block tokens by role. A non-semantic surface uses the neutral `--accent` wash, not a copied hex.

## Don'ts

1. **No fonts other than Inter, JetBrains Mono, and Figtree (brand wordmark only).** Do not import Roboto, system-ui first, Fraunces, or Arial. The font stacks in `themes.css` are the only legal stacks. Figtree is the one registered third face — it is reserved for the `CADENCR` wordmark (`--font-brand`, weight 800) and must not be used for UI or body text. If a further face is needed, add it here with a clear role.
2. **No hardcoded hex in JSX.** Every color in a component file goes through a `var(--...)` lookup. Inline `style={{ color: "#..." }}` is forbidden except for placeholder squares in fixtures (and even those should be CSS classes).
3. **No purple gradients on white.** Aurora is light but not whimsical. Solid colors only; the only gradients in the system are the `--primary-glow` color-mix effects on focus/hover.
4. **No new spacing values outside the kit.css scale.** If you need 11px, you actually need 10 or 12. If you need 13px, use 12 or 14. Pick the closest step.
5. **Thinking blocks always use the thinking block tokens, never `accent` or `primary`.** The contract is semantic separation even when a legacy theme makes two roles look similar.
6. **No CSS-in-JS.** All styling lives in `kit.css` and `themes.css`. JSX may reference CSS variables inline (`style={{ background: "var(--acc-green)" }}` is fine for a one-off swatch), but no `styled-components`-style libraries, no inline rule sets larger than ~3 declarations, and no class-name generators.
7. **No new layout without registering it in all three places** — `config` useMemo, `kit.css` `cds-split` rules, and the `TweakRadio` options. A layout that exists in two of the three is a bug.
8. **Brand and status greens never share a token.** The logo and primary actions use `--primary`; ready and added states use their semantic tokens. Emerald branding must never make a neutral control look successful.
9. **The `--code-bg` / `--code-fg` surface stays dark even in Aurora.** Markdown code blocks and editor-adjacent code surfaces are intentionally Dracula-like in the light theme — a white code block looks washed-out and breaks the dev-tool convention. The bash tool-call block is the one carve-out: it follows the theme via `--block-bash-*` (see "Bash variant").
10. **Live terminal (xterm/PTY) never inverts.** Always uses `--code-bg` and stays dark regardless of theme. Future theme JSONs MUST keep `terminal.bg` dark.
11. **No new screen-level routes without a `data-screen-label`.** Every full-pane screen must set `data-screen-label="NN Title"` (1-indexed) on the `.cds-app` so review comments can pin to it.
12. **No prompt bar outside the root pane.** It lives once, in the non-floating root pane. Floating panes never own input.
13. **No untranslated tweak.** Every value in `TWEAK_DEFAULTS` must round-trip through the Tweaks panel — i.e. there is a `Tweak*` control bound to it. No "secret" tweaks.

## Self-audit (sample screens)

**Settings panel.** Already covered — uses `--card`, `--border`, `--muted`, sidebar tokens for nav, primary for active row. No new tokens needed; the page goes through `screen="settings"` and renders `<window.SettingsPage>`. ✓

**Empty-state for the agent stream.** Tokens needed:

- `--muted-foreground` for the prose
- `--accent` for the "What can I help with?" affordance background
- An icon at 32px stroke-2 (extension of the `iconography.scale` — added "xl: 32" implicitly; explicitly noted that empty states may use `28–40px` icons, the only place above 22).

**Error toast.** Needed tokens:

- `--acc-red` (border + accent strip)
- `--card` (toast surface)
- `--shadow-pop` (lift)
- 4–6s auto-dismiss falls under `transitions` but isn't currently a token. **Added constraint:** ephemeral overlay durations (toast, tooltip auto-hide) use `transitions.toast: 4000ms`. Add this if/when toasts ship — until then, do not invent a duration.

**Audit conclusion.** The token coverage is complete for current surfaces. Two implicit constraints surfaced and are now explicit in the YAML/Don'ts: code surfaces stay dark across themes (rule 9), and large empty-state icons are the only legal exception to the icon size cap.
