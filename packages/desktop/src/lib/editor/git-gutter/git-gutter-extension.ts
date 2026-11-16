/**
 * Git change-marker gutter — VS Code-style added/modified/deleted bars next to
 * the line numbers, driven entirely by client-side diffing of the live buffer
 * against the file's HEAD baseline (no backend route, per this track's
 * constraint).
 *
 * Design:
 *  – a `StateField` holds the current baseline (HEAD content) and the derived
 *    marker kind per changed line; an effect (`setGitGutterBaseline`) swaps the baseline,
 *    and any `docChanged` transaction re-diffs so markers track edits live;
 *  – the pure `computeGitLineMarkers` diffs the two texts line by line (with
 *    `@codemirror/merge`'s `diff`, already a dependency) into per-line markers;
 *  – a `gutter()` renders one `GutterMarker` per changed line. Colours come from
 *    DESIGN.md status tokens: `--acc-green` (added), `--acc-red` (deleted),
 *    One-Dark blue (modified).
 *
 * Bounded work: re-diffing runs synchronously inside the update transaction.
 * Only the lines between the texts' shared prefix and suffix are diffed, and
 * the diff is bounded (`LINE_DIFF_CONFIG`) so a heavily rewritten file
 * (a reformat) falls back to the cheap algorithm instead of going quadratic.
 * The caller (`useGitGutter`) additionally never enables this in large-file
 * mode.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { computeGitLineMarkers, toEditorLineBreaks, type GitMarkerKind } from "./diff-to-markers";

/** Swap the HEAD baseline the gutter diffs against. `null` clears all markers. */
export const setGitGutterBaseline = StateEffect.define<string | null>();

interface GitGutterState {
  baseline: string | null;
  /** Marker kind by 1-based line; a reformat can mark every line. */
  kinds: ReadonlyMap<number, GitMarkerKind>;
}

const NO_MARKERS: ReadonlyMap<number, GitMarkerKind> = new Map();

function diffMarkers(baseline: string | null, doc: string): ReadonlyMap<number, GitMarkerKind> {
  if (baseline === null) return NO_MARKERS;
  const markers = computeGitLineMarkers(baseline, doc);
  return markers.length === 0 ? NO_MARKERS : new Map(markers.map((m) => [m.line, m.kind]));
}

const gitGutterField = StateField.define<GitGutterState>({
  create: () => ({ baseline: null, kinds: NO_MARKERS }),
  update(value, tr) {
    let baseline = value.baseline;
    let baselineChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setGitGutterBaseline)) {
        // Normalized once here rather than on every keystroke's re-diff.
        baseline = effect.value === null ? null : toEditorLineBreaks(effect.value);
        baselineChanged = true;
      }
    }
    if (!baselineChanged && !tr.docChanged) return value;
    return { baseline, kinds: diffMarkers(baseline, tr.newDoc.toString()) };
  },
});

class GitChangeMarker extends GutterMarker {
  constructor(private readonly kind: GitMarkerKind) {
    super();
  }
  override eq(other: GitChangeMarker): boolean {
    return other.kind === this.kind;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-git-gutter-marker cm-git-gutter-${this.kind}`;
    return el;
  }
}

const MARKER_BY_KIND: Record<GitMarkerKind, GitChangeMarker> = {
  added: new GitChangeMarker("added"),
  modified: new GitChangeMarker("modified"),
  deleted: new GitChangeMarker("deleted"),
};

const gitGutterTheme = EditorView.baseTheme({
  ".cm-git-gutter": { width: "3px", paddingLeft: "1px" },
  ".cm-git-gutter-marker": { height: "100%", width: "3px", boxSizing: "border-box" },
  ".cm-git-gutter-added": { background: "var(--acc-green, #50fa7b)" },
  // Modified uses the cyan/blue accent (the same hue DESIGN.md assigns to diff
  // and branch info); green/red stay reserved for added/deleted.
  ".cm-git-gutter-modified": { background: "var(--acc-cyan, #8be9fd)" },
  // Deleted lines are gone from the buffer, so the marker is a thin triangle
  // pointing at the line that now sits where the deletion happened.
  ".cm-git-gutter-deleted": {
    background: "transparent",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "4px solid var(--acc-red, #ff5555)",
    width: "0",
    height: "0",
    marginTop: "2px",
  },
});

const gitChangeGutter = gutter({
  class: "cm-git-gutter",
  lineMarker(view, blockLine) {
    const state = view.state.field(gitGutterField, false);
    if (!state || state.kinds.size === 0) return null;
    const kind = state.kinds.get(view.state.doc.lineAt(blockLine.from).number);
    return kind ? MARKER_BY_KIND[kind] : null;
  },
  lineMarkerChange(update) {
    return update.startState.field(gitGutterField) !== update.state.field(gitGutterField);
  },
});

/** The full git-gutter extension. Mount once; feed baselines via the effect. */
export function gitGutterExtension(): Extension {
  return [gitGutterField, gitChangeGutter, gitGutterTheme];
}
