/**
 * Search-match painting via the CSS Custom Highlight API.
 *
 * The conversation stream is virtualized, so we can't wrap matches in `<mark>`
 * (most matches aren't even mounted) and we don't want to mutate React-owned
 * DOM. The Custom Highlight API lets us paint arbitrary `Range`s without
 * touching the tree: we register a `Highlight` of every visible occurrence and
 * a second, higher-priority one for the active match.
 *
 * The `::highlight(...)` paint styles are injected at runtime (see
 * `ensureHighlightStyles`) rather than living in `theme.css`: Lightning CSS (the
 * Tailwind build's CSS optimizer) doesn't recognize the `::highlight()`
 * pseudo-element and warns on it, whereas Chromium parses it natively. The match
 * fill uses `--acc-yellow`/`--code-bg` (which invert together per theme so the
 * fill always reads cleanly) and the active match uses the brand `--primary` so
 * the current occurrence stands apart from the rest.
 *
 * Ranges go stale when Virtuoso recycles rows, so callers repaint on scroll.
 */

const MATCH_HIGHLIGHT = "cadencr-conversation-match";
const ACTIVE_HIGHLIGHT = "cadencr-conversation-match-active";

const HIGHLIGHT_STYLES = `
::highlight(${MATCH_HIGHLIGHT}) {
  background-color: var(--acc-yellow);
  color: var(--code-bg);
}
::highlight(${ACTIVE_HIGHLIGHT}) {
  background-color: var(--primary);
  color: var(--primary-foreground);
}
`;

let highlightStyleSheet: CSSStyleSheet | null = null;

/** Adopt the `::highlight(...)` paint rules into the document once, lazily. */
function ensureHighlightStyles(): void {
  if (highlightStyleSheet || typeof CSSStyleSheet === "undefined") return;
  highlightStyleSheet = new CSSStyleSheet();
  highlightStyleSheet.replaceSync(HIGHLIGHT_STYLES);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, highlightStyleSheet];
}

/** Search-bar UI carries this attribute so the walker never highlights itself. */
export const SEARCH_UI_ATTR = "data-conversation-search-ui";

export interface ActiveMatchTarget {
  blockId: string;
  occurrenceInBlock: number;
}

export function supportsHighlightApi(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined" &&
    typeof Range !== "undefined"
  );
}

export function clearConversationHighlights(): void {
  if (!supportsHighlightApi()) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_HIGHLIGHT);
}

/** Collect a literal, case-insensitive substring's ranges within one text node. */
function rangesInTextNode(node: Text, needleLower: string): Range[] {
  const haystack = node.data.toLowerCase();
  const ranges: Range[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needleLower, from);
    if (idx === -1) break;
    const range = new Range();
    range.setStart(node, idx);
    range.setEnd(node, idx + needleLower.length);
    ranges.push(range);
    from = idx + needleLower.length;
  }
  return ranges;
}

function collectRanges(root: HTMLElement, needleLower: string, skipSearchUi: boolean): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node): number => {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (skipSearchUi && node.parentElement?.closest(`[${SEARCH_UI_ATTR}]`) != null) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    ranges.push(...rangesInTextNode(node as Text, needleLower));
  }
  return ranges;
}

/**
 * Repaint the match + active-match highlights for the current query.
 *
 * `scroller` is the virtualized stream container. `active` targets a specific
 * occurrence inside one block (located by `data-block-id`); if that occurrence
 * isn't rendered (block off-screen or its head collapsed) no active match is
 * painted, so the active style never lands on the wrong occurrence.
 */
export function paintConversationHighlights(
  scroller: HTMLElement,
  query: string,
  active: ActiveMatchTarget | null,
): void {
  if (!supportsHighlightApi()) return;
  const needle = query.trim().toLowerCase();
  if (!needle) {
    clearConversationHighlights();
    return;
  }

  const allRanges = collectRanges(scroller, needle, true);
  if (allRanges.length === 0) {
    clearConversationHighlights();
    return;
  }
  ensureHighlightStyles();
  CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...allRanges));

  const activeRange = resolveActiveRange(scroller, needle, active);
  if (activeRange) {
    const highlight = new Highlight(activeRange);
    highlight.priority = 1; // paint over the base match highlight
    CSS.highlights.set(ACTIVE_HIGHLIGHT, highlight);
  } else {
    CSS.highlights.delete(ACTIVE_HIGHLIGHT);
  }
}

/**
 * Center the active occurrence when it's scrolled out of the viewport.
 *
 * `scrollToIndex` only brings the *row* into view, but a single block can be
 * taller than the viewport (long messages, tool output, thinking), so the
 * specific occurrence can still sit off-screen. We resolve its range and nudge
 * `scrollTop` so the match is actually visible — without this, stepping through
 * matches inside one tall block looks like the highlight vanished.
 */
export function scrollActiveMatchIntoView(
  scroller: HTMLElement,
  query: string,
  active: ActiveMatchTarget | null,
): void {
  if (!supportsHighlightApi() || !active) return;
  const needle = query.trim().toLowerCase();
  if (!needle) return;
  const range = resolveActiveRange(scroller, needle, active);
  if (!range) return;
  const rect = range.getBoundingClientRect();
  if (rect.height === 0) return;
  const view = scroller.getBoundingClientRect();
  if (rect.top >= view.top && rect.bottom <= view.bottom) return; // already visible
  scroller.scrollTop += rect.top - view.top - (view.height - rect.height) / 2;
}

function resolveActiveRange(
  scroller: HTMLElement,
  needleLower: string,
  active: ActiveMatchTarget | null,
): Range | null {
  if (!active) return null;
  const blockEl = scroller.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(active.blockId)}"]`,
  );
  if (!blockEl) return null;
  // Index straight to the occurrence; never clamp to a different one. If the
  // target isn't rendered (collapsed/truncated content), paint no active match
  // rather than a wrong one.
  const ranges = collectRanges(blockEl, needleLower, false);
  return ranges[active.occurrenceInBlock] ?? null;
}
