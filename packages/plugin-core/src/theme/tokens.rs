//! The closed set of design tokens a theme may set, plus the contrast pairs
//! every theme must clear.
//!
//! Two tiers. [`REQUIRED_TOKENS`] is the palette every theme must define in
//! full. [`OPTIONAL_TOKENS`] is the shorter list the *chrome* layer reads: a
//! theme that opts into a shape may color it, and a theme that doesn't say
//! nothing and gets the stylesheet's fallback.
//!
//! This mirrors `packages/desktop/src/lib/themes/tokens.ts` — the renderer
//! needs the list to duplicate a built-in theme, the service needs it to
//! validate what lands on disk. `scripts/theme-tokens.test.mjs` fails the build
//! if the two ever drift.

/// Every token a theme must define. Derived from the first-party themes: it is
/// the exact set of custom properties every `:root[data-theme="…"]` block
/// declares in common.
pub const REQUIRED_TOKENS: &[&str] = &[
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
];

/// Tokens a theme *may* define, and the app has an answer for when it doesn't.
///
/// These are the colors `theme-chrome.css` reads for the shapes a theme opts
/// into — the segmented tab control and the rail's page edge. They were declared
/// by the CadencR pair alone, in a stylesheet, which left a duplicated theme
/// with the shape and none of its colors: segmented tabs fell back to a
/// deliberately neutral mix, and the only way to change that was to edit the
/// app's own stylesheet. That is not a change anyone with an installed Cadencr
/// can make, and it would have applied to every theme at once. So the tokens
/// belong to the theme instead.
///
/// Optional, not required, because most themes take the underline tabs and the
/// flat chassis and would otherwise be forced to name colors for chrome they
/// never draw. Every one still has to be a real color, and an unknown key is
/// still an error — this widens the vocabulary, it does not open it.
///
/// `--tab-active-shadow` and `--page-shadow` are deliberately absent: they hold
/// `box-shadow` values, not colors, and the gate here parses colors. They stay
/// the stylesheet's business.
pub const OPTIONAL_TOKENS: &[&str] = &[
    // Segmented tabs — the recessed track and the raised pill on top of it.
    "--tab-track-bg",
    "--tab-track-border",
    "--tab-active-bg",
    // The rail chassis' page edge, and the hairline around raised panes.
    "--pane-border",
];

/// Foreground/background pairs that must stay legible.
///
/// Thresholds are **calibrated against the fourteen first-party themes**, not
/// copied off the WCAG table, because a duplicate of a shipped theme has to
/// pass: a gate strict enough to reject Frost Dark is a gate that rejects the
/// first thing every user creates. Where the shipped themes clear AA the check
/// demands AA; where they don't, the tier says so rather than overclaiming.
///
/// Deliberately a small, high-signal set rather than every combination: it
/// catches "I made the text the same color as the background" without turning
/// theme authoring into an accessibility audit.
pub const CONTRAST_PAIRS: &[ContrastPair] = &[
    // Body text. Every first-party theme clears 4.5:1 here with margin
    // (the tightest is Frost Dark's card at 5.31:1).
    ContrastPair::text("--foreground", "--background"),
    ContrastPair::text("--card-foreground", "--card"),
    ContrastPair::text("--popover-foreground", "--popover"),
    ContrastPair::text("--sidebar-foreground", "--sidebar"),
    ContrastPair::text("--secondary-foreground", "--secondary"),
    ContrastPair::text("--code-fg", "--code-bg"),
    ContrastPair::text("--editor-fg", "--editor-bg"),
    ContrastPair::text("--block-bash-fg", "--block-bash-body-bg"),
    // Chrome and short/large type: button labels, hover fills, block headers,
    // secondary text. The first-party floor across these is 3.08:1
    // (Frost Dark's muted text), so 3:1 — WCAG's own large-text / non-text
    // level — is the most this tier can honestly require.
    ContrastPair::ui("--primary-foreground", "--primary"),
    ContrastPair::ui("--sidebar-primary-foreground", "--sidebar-primary"),
    ContrastPair::ui("--accent-foreground", "--accent"),
    ContrastPair::ui("--sidebar-accent-foreground", "--sidebar-accent"),
    ContrastPair::ui("--muted-foreground", "--background"),
    ContrastPair::ui("--muted-foreground", "--muted"),
    ContrastPair::ui("--block-tool-accent", "--block-tool-bg"),
    ContrastPair::ui("--block-thinking-accent", "--block-thinking-bg"),
    ContrastPair::ui("--block-plan-accent", "--block-plan-bg"),
    // Frost Dark's destructive button sits at 2.99:1, so we can't ask for 3:1
    // here without rejecting it. This tier only asserts the two colors are
    // distinguishable at all — which is exactly the mistake worth catching.
    ContrastPair::distinct("--destructive-foreground", "--destructive"),
];

/// WCAG AA for body text.
pub const TEXT_CONTRAST_MIN: f64 = 4.5;
/// WCAG AA for large text and non-text UI components.
pub const UI_CONTRAST_MIN: f64 = 3.0;
/// Not a WCAG level: "these are visibly different colors". Used only where the
/// shipped themes don't reach the UI floor.
pub const DISTINCT_CONTRAST_MIN: f64 = 1.5;

#[derive(Debug, Clone, Copy)]
pub struct ContrastPair {
    pub foreground: &'static str,
    pub background: &'static str,
    pub min_ratio: f64,
}

impl ContrastPair {
    const fn of(foreground: &'static str, background: &'static str, min_ratio: f64) -> Self {
        Self {
            foreground,
            background,
            min_ratio,
        }
    }

    const fn text(foreground: &'static str, background: &'static str) -> Self {
        Self::of(foreground, background, TEXT_CONTRAST_MIN)
    }

    const fn ui(foreground: &'static str, background: &'static str) -> Self {
        Self::of(foreground, background, UI_CONTRAST_MIN)
    }

    const fn distinct(foreground: &'static str, background: &'static str) -> Self {
        Self::of(foreground, background, DISTINCT_CONTRAST_MIN)
    }
}

/// Membership is checked once per token per validation, and validation runs for
/// every theme on every list — a linear scan of 104 strings turns that into
/// thousands of comparisons per request.
static TOKEN_SET: std::sync::LazyLock<std::collections::HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        REQUIRED_TOKENS
            .iter()
            .chain(OPTIONAL_TOKENS)
            .copied()
            .collect()
    });

/// Whether a theme is allowed to set this token at all — either tier.
pub fn is_known_token(key: &str) -> bool {
    TOKEN_SET.contains(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn token_list_has_no_duplicates() {
        let all: Vec<_> = REQUIRED_TOKENS.iter().chain(OPTIONAL_TOKENS).collect();
        let unique: HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len());
    }

    /// A contrast pair is measured on every theme, so both sides have to be
    /// tokens every theme has. An optional token can be absent, and a pair
    /// naming one would silently never be checked.
    #[test]
    fn contrast_pairs_reference_required_tokens() {
        for pair in CONTRAST_PAIRS {
            assert!(
                REQUIRED_TOKENS.contains(&pair.foreground),
                "{}",
                pair.foreground
            );
            assert!(
                REQUIRED_TOKENS.contains(&pair.background),
                "{}",
                pair.background
            );
        }
    }

    #[test]
    fn both_tiers_are_settable_and_nothing_else_is() {
        assert!(is_known_token("--background"));
        assert!(is_known_token("--tab-track-bg"));
        assert!(!is_known_token("--tab-active-shadow"));
        assert!(!is_known_token("--evil"));
    }
}
