/**
 * The closed set of design tokens a theme may set.
 *
 * This list is *derived from the first-party themes*, not invented: it is the
 * exact set of CSS custom properties every `:root[data-theme="…"]` block in
 * `theme.css` / `theme-cadencr.css` / `theme-square.css` / `theme-frost.css`
 * declares in common (see DESIGN.md for what each one paints). A theme sets
 * these and nothing else — never arbitrary CSS — which is what makes a theme
 * pure, sandbox-free data.
 *
 * Theme-family extras (Frost's `--glass-*`, the square themes' `--radius`) stay
 * in their stylesheets: they reshape geometry and material, not color, and are
 * out of scope for user themes in v1.
 */
export const THEME_TOKEN_KEYS = [
  // Tailwind semantic tokens — the shadcn/ui surface + text scale.
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--surface-sunken",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  // Vibrant accent palette — editor syntax, diff decorations, markdown code.
  "--acc-cyan",
  "--acc-green",
  "--acc-orange",
  "--acc-pink",
  "--acc-purple",
  "--acc-red",
  "--acc-yellow",
  "--acc-comment",
  // Code surface — editor-adjacent code-only surfaces.
  "--code-bg",
  "--code-fg",
  // Agent-stream block surfaces (`*-bg` paints the container, `*-accent` the title row/icon/border).
  "--block-tool-bg",
  "--block-tool-accent",
  "--block-thinking-bg",
  "--block-thinking-accent",
  "--block-plan-bg",
  "--block-plan-accent",
  "--block-bash-header-bg",
  "--block-bash-body-bg",
  "--block-bash-fg",
  "--block-bash-muted-fg",
  "--block-task-bg",
  // App-level semantic accents — chips and numstat, tuned independently of editor syntax.
  "--numstat-add-fg",
  "--numstat-del-fg",
  "--chip-worktree-bg",
  "--chip-worktree-bg-hover",
  "--chip-worktree-fg",
  "--chip-shared-worktree-bg",
  "--chip-shared-worktree-fg",
  "--chip-violet-bg",
  "--chip-violet-fg",
  "--chip-violet-soft",
  "--chip-fuchsia-bg",
  "--chip-fuchsia-fg",
  "--chip-blue-bg",
  "--chip-blue-fg",
  // CodeMirror editor palette.
  "--editor-bg",
  "--editor-fg",
  "--editor-comment",
  "--editor-cyan",
  "--editor-green",
  "--editor-orange",
  "--editor-pink",
  "--editor-purple",
  "--editor-red",
  "--editor-yellow",
  "--editor-border",
  "--editor-cursor",
  "--editor-line-highlight",
  "--editor-gutter-bg",
  "--editor-gutter-fg",
  "--editor-selection-bg",
  "--editor-selection-bg-soft",
  "--editor-search-match-bg",
  // Diff decorations (CodeMirror merge view + InlineDiffBlock).
  "--diff-add-bg",
  "--diff-add-bg-strong",
  "--diff-del-bg",
  "--diff-del-bg-strong",
  // Terminal chrome — panel buttons, resize handles, cwd-warning banner.
  "--terminal-bg",
  "--terminal-panel-icon",
  "--terminal-panel-icon-hover",
  "--terminal-panel-icon-bg-hover",
  "--terminal-panel-handle-bg",
  "--terminal-panel-handle-bg-hover",
  "--terminal-warning-bg",
  "--terminal-warning-border",
  "--terminal-warning-fg",
  "--terminal-warning-fg-secondary",
  "--terminal-warning-accent",
  "--terminal-warning-link",
  "--terminal-warning-button-bg",
  "--terminal-warning-button-bg-hover",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

/**
 * Tokens a theme *may* set. Mirrors `OPTIONAL_TOKENS` in the service.
 *
 * These color the shapes a theme opts into through `chrome` — the segmented tab
 * control and the rail's page edge — and `theme-chrome.css` derives a fallback
 * from the palette for any a theme leaves out. They are optional because most
 * themes draw neither shape and shouldn't have to name colors for chrome they
 * never paint.
 *
 * `--chart-6` is the categorical palette's sixth slot. It came after themes
 * were already published, so it is optional too and its readers fall back to
 * a mix of the five required slots.
 *
 * `--tab-active-shadow` and `--page-shadow` stay out: they are `box-shadow`
 * values rather than colors, and the theme vocabulary is colors.
 */
export const THEME_OPTIONAL_TOKEN_KEYS = [
  "--tab-track-bg",
  "--tab-track-border",
  "--tab-active-bg",
  "--pane-border",
  "--chart-6",
] as const;

export type ThemeOptionalTokenKey = (typeof THEME_OPTIONAL_TOKEN_KEYS)[number];

/** A complete token set. Every required key must be present — a theme is
 *  duplicated from a working one, so a missing token means the file was
 *  hand-edited into an incomplete state and must not be applied. The optional
 *  chrome tokens are carried the same way when a theme declares them. */
export type ThemeCssVars = Record<ThemeTokenKey, string> &
  Partial<Record<ThemeOptionalTokenKey, string>>;
