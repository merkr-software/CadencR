import { translateUi } from "@/lib/i18n/ui";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { SearchCursor, RegExpCursor } from "@codemirror/search";
import { apiErrorMessage } from "@/lib/api-errors";

export interface BufferSearchQuery {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

export interface BufferMatch {
  from: number;
  to: number;
}

export interface BufferSearchState {
  query: BufferSearchQuery;
  matches: BufferMatch[];
  activeIndex: number;
  truncated: boolean;
  error: string | null;
}

export const MAX_BUFFER_MATCHES = 5000;

const EMPTY_QUERY: BufferSearchQuery = { query: "", caseSensitive: false, regex: false };

const INITIAL_STATE: BufferSearchState = {
  query: EMPTY_QUERY,
  matches: [],
  activeIndex: -1,
  truncated: false,
  error: null,
};

export const setBufferSearchQueryEffect = StateEffect.define<BufferSearchQuery>();
export const setBufferActiveIndexEffect = StateEffect.define<number>();
export const closeBufferSearchEffect = StateEffect.define<void>();

const matchMark = Decoration.mark({ class: "cm-buffer-search-match" });
const activeMatchMark = Decoration.mark({
  class: "cm-buffer-search-match cm-buffer-search-match-active",
});

interface CursorLike {
  next(): { done: boolean };
  value: { from: number; to: number };
}

interface ScanResult {
  matches: BufferMatch[];
  truncated: boolean;
  error: string | null;
}

/**
 * Drain a CodeMirror SearchCursor / RegExpCursor into a match list, capped at
 * MAX_BUFFER_MATCHES. Zero-width matches (e.g. regex like `\b`, `^`) are kept;
 * if the cursor ever stalls on the same zero-width position twice in a row we
 * break to avoid an infinite loop.
 */
function drainCursor(cursor: CursorLike): { matches: BufferMatch[]; truncated: boolean } {
  const matches: BufferMatch[] = [];
  let lastZeroWidthEnd = -1;
  while (!cursor.next().done) {
    const { from, to } = cursor.value;
    if (from === to) {
      if (to === lastZeroWidthEnd) break;
      lastZeroWidthEnd = to;
    } else {
      lastZeroWidthEnd = -1;
    }
    matches.push({ from, to });
    if (matches.length >= MAX_BUFFER_MATCHES) {
      return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

function scanLiteralMatches(state: EditorState, q: BufferSearchQuery): ScanResult {
  const normalize = q.caseSensitive ? undefined : (s: string) => s.toLowerCase();
  const cursor = new SearchCursor(state.doc, q.query, 0, state.doc.length, normalize);
  const { matches, truncated } = drainCursor(cursor);
  return { matches, truncated, error: null };
}

function scanRegexMatches(state: EditorState, q: BufferSearchQuery): ScanResult {
  // Wrap both the cursor construction AND the drain in the same try/catch:
  // RegExpCursor compiles its own internal regex (with the `i` flag when
  // `ignoreCase` is set) and can throw at construction time for patterns that
  // `new RegExp(q.query)` would have accepted as-is. Iteration can also throw
  // for some edge patterns. A leaked exception here would crash the editor
  // transaction; surfacing it as an error keeps the UI alive.
  try {
    const cursor = new RegExpCursor(
      state.doc,
      q.query,
      { ignoreCase: !q.caseSensitive },
      0,
      state.doc.length,
    );
    const { matches, truncated } = drainCursor(cursor);
    return { matches, truncated, error: null };
  } catch (err) {
    return {
      matches: [],
      truncated: false,
      error: apiErrorMessage(
        err,
        translateUi("workspace.editor.search-extension.invalidRegex", "Invalid regex"),
      ),
    };
  }
}

function scanMatches(state: EditorState, q: BufferSearchQuery): ScanResult {
  if (!q.query) return { matches: [], truncated: false, error: null };
  return q.regex ? scanRegexMatches(state, q) : scanLiteralMatches(state, q);
}

function pickInitialActive(matches: BufferMatch[], cursorPos: number): number {
  if (matches.length === 0) return -1;
  // Prefer the match the cursor is currently inside, otherwise the next match
  // after the cursor. `match.to > cursorPos` covers both: it is true when the
  // cursor sits inside the match (from <= cursorPos < to) and when the match
  // starts after the cursor. Falls back to the first match if the cursor is
  // past every match.
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].to > cursorPos) return i;
  }
  return 0;
}

function normalizeIndex(idx: number, total: number): number {
  if (total === 0) return -1;
  return ((idx % total) + total) % total;
}

function buildDecorations(state: BufferSearchState): DecorationSet {
  if (state.matches.length === 0) return Decoration.none;
  const ranges = state.matches.map((m, i) =>
    (i === state.activeIndex ? activeMatchMark : matchMark).range(m.from, m.to),
  );
  return Decoration.set(ranges, true);
}

function applyQueryEffect(state: EditorState, query: BufferSearchQuery): BufferSearchState {
  const scan = scanMatches(state, query);
  return {
    query,
    matches: scan.matches,
    activeIndex: pickInitialActive(scan.matches, state.selection.main.head),
    truncated: scan.truncated,
    error: scan.error,
  };
}

function reapplyOnDocChange(prev: BufferSearchState, tr: Transaction): BufferSearchState {
  const scan = scanMatches(tr.state, prev.query);
  if (scan.matches.length === 0) {
    return { ...prev, matches: [], activeIndex: -1, truncated: false, error: scan.error };
  }
  const prevActiveMatch = prev.activeIndex >= 0 ? prev.matches[prev.activeIndex] : null;
  const anchor = prevActiveMatch
    ? tr.changes.mapPos(prevActiveMatch.from)
    : tr.state.selection.main.head;
  return {
    ...prev,
    matches: scan.matches,
    activeIndex: pickInitialActive(scan.matches, anchor),
    truncated: scan.truncated,
    error: scan.error,
  };
}

export const bufferSearchField = StateField.define<BufferSearchState>({
  create: () => INITIAL_STATE,
  update(value, tr) {
    let next = value;
    let queryChanged = false;
    let closed = false;
    for (const effect of tr.effects) {
      if (effect.is(setBufferSearchQueryEffect)) {
        next = applyQueryEffect(tr.state, effect.value);
        queryChanged = true;
      } else if (effect.is(setBufferActiveIndexEffect)) {
        next = { ...next, activeIndex: normalizeIndex(effect.value, next.matches.length) };
      } else if (effect.is(closeBufferSearchEffect)) {
        next = INITIAL_STATE;
        closed = true;
      }
    }
    if (tr.docChanged && !queryChanged && !closed && next.query.query) {
      next = reapplyOnDocChange(next, tr);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, buildDecorations),
});

type Listener = (state: BufferSearchState) => void;
const listenersByView = new WeakMap<EditorView, Set<Listener>>();

function notifyListeners(view: EditorView, state: BufferSearchState): void {
  const set = listenersByView.get(view);
  if (!set) return;
  set.forEach((cb) => cb(state));
}

export function subscribeBufferSearch(view: EditorView, cb: Listener): () => void {
  let set = listenersByView.get(view);
  if (!set) {
    set = new Set();
    listenersByView.set(view, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

export function bufferSearchExtension(): Extension {
  return [
    bufferSearchField,
    EditorView.updateListener.of((update) => {
      const prev = update.startState.field(bufferSearchField, false);
      const next = update.state.field(bufferSearchField, false);
      if (next === undefined || prev === next) return;
      notifyListeners(update.view, next);
    }),
  ];
}

export function getBufferSearchState(view: EditorView): BufferSearchState {
  return view.state.field(bufferSearchField);
}

/**
 * Apply a new query / regex / case-sensitivity setting. Neither the editor
 * selection nor the viewport is moved — typing in the search input should not
 * yank the buffer around on every keystroke. Scrolling and selection only
 * happen on explicit navigation (`findNextMatch`, `findPrevMatch`,
 * `selectActiveMatch`).
 */
export function setBufferSearchQuery(view: EditorView, query: BufferSearchQuery): void {
  view.dispatch({ effects: setBufferSearchQueryEffect.of(query) });
}

export function findNextMatch(view: EditorView): void {
  const s = view.state.field(bufferSearchField);
  if (s.matches.length === 0) return;
  activateMatch(view, s.activeIndex + 1);
}

export function findPrevMatch(view: EditorView): void {
  const s = view.state.field(bufferSearchField);
  if (s.matches.length === 0) return;
  activateMatch(view, s.activeIndex - 1);
}

export function closeBufferSearch(view: EditorView): void {
  view.dispatch({ effects: closeBufferSearchEffect.of() });
}

/** Move the editor selection to the currently-active match without changing it. */
export function selectActiveMatch(view: EditorView): void {
  const s = view.state.field(bufferSearchField);
  if (s.activeIndex < 0) return;
  const m = s.matches[s.activeIndex];
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: EditorView.scrollIntoView(m.from, { y: "center" }),
  });
}

function activateMatch(view: EditorView, rawIndex: number): void {
  const s = view.state.field(bufferSearchField);
  if (s.matches.length === 0) return;
  const idx = normalizeIndex(rawIndex, s.matches.length);
  const m = s.matches[idx];
  view.dispatch({
    effects: [
      setBufferActiveIndexEffect.of(idx),
      EditorView.scrollIntoView(m.from, { y: "center" }),
    ],
    selection: { anchor: m.from, head: m.to },
  });
}

/**
 * Replace the currently-active match with `replacement` and advance to the
 * next match. No-ops when there is no match. The replacement is inserted
 * verbatim — regex backreferences (`$1`, `\1`) are not interpreted, matching
 * the literal-replace behavior most users expect from Find & Replace UIs.
 */
export function replaceActiveMatch(view: EditorView, replacement: string): void {
  const s = view.state.field(bufferSearchField);
  if (s.activeIndex < 0) return;
  const m = s.matches[s.activeIndex];
  view.dispatch({
    changes: { from: m.from, to: m.to, insert: replacement },
    // After replacement, the matches list is re-scanned in `update()` via
    // `reapplyOnDocChange`; the active index is re-derived from the cursor.
    // Move the cursor to the end of the inserted text so the *next* match
    // is the natural one to highlight.
    selection: { anchor: m.from + replacement.length },
    scrollIntoView: true,
  });
}

/**
 * Replace every match with `replacement` in a single transaction.
 * Returns the number of replacements performed.
 */
export function replaceAllMatches(view: EditorView, replacement: string): number {
  const s = view.state.field(bufferSearchField);
  if (s.matches.length === 0) return 0;
  const changes = s.matches.map((m) => ({ from: m.from, to: m.to, insert: replacement }));
  view.dispatch({ changes });
  return s.matches.length;
}
