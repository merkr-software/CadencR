/**
 * Git change-marker gutter — VS Code-style added/modified/deleted bars next to
 * the line numbers, driven entirely by client-side diffing of the live buffer
 * against the file's HEAD baseline (no backend route, per this track's
 * constraint).
 *
 * Design:
 *  – a `StateField` holds the current baseline (HEAD content) and the derived
 *    `GitLineMarker[]`; an effect (`setGitGutterBaseline`) swaps the baseline,
 *    and any `docChanged` transaction re-diffs so markers track edits live;
 *  – the diff itself is `presentableDiff` from `@codemirror/merge` (already a
 *    dependency) → mapped to per-line markers by the pure `computeGitLineMarkers`;
 *  – a `gutter()` renders one `GutterMarker` per changed line. Colours come from
 *    DESIGN.md status tokens: `--acc-green` (added), `--acc-red` (deleted),
 *    One-Dark blue (modified).
 *
 * Bounded work: re-diffing runs synchronously inside the update transaction.
 * `presentableDiff` is given a `scanLimit` so pathological large/very-different
 * inputs fall back to the cheap algorithm instead of going quadratic. The
 * caller (`useGitGutter`) additionally never enables this in large-file mode.
 */
import { presentableDiff } from "@codemirror/merge";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { computeGitLineMarkers, type GitLineMarker, type GitMarkerKind } from "./diff-to-markers";

/** Cap the diff scan so a huge/very-different buffer can't freeze the editor. */
const GIT_GUTTER_SCAN_LIMIT = 20_000;

/** Swap the HEAD baseline the gutter diffs against. `null` clears all markers. */
export const setGitGutterBaseline = StateEffect.define<string | null>();

interface GitGutterState {
  baseline: string | null;
  markers: GitLineMarker[];
}

function diffMarkers(baseline: string | null, doc: string): GitLineMarker[] {
  if (baseline === null) return [];
  if (baseline === doc) return [];
  const changes = presentableDiff(baseline, doc, { scanLimit: GIT_GUTTER_SCAN_LIMIT });
  return computeGitLineMarkers(baseline, doc, changes);
}

const gitGutterField = StateField.define<GitGutterState>({
  create: () => ({ baseline: null, markers: [] }),
  update(value, tr) {
    let baseline = value.baseline;
    let baselineChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setGitGutterBaseline)) {
        baseline = effect.value;
        baselineChanged = true;
      }
    }
    if (!baselineChanged && !tr.docChanged) return value;
    return { baseline, markers: diffMarkers(baseline, tr.newDoc.toString()) };
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
    if (!state || state.markers.length === 0) return null;
    const line = view.state.doc.lineAt(blockLine.from).number;
    // Linear membership check is fine: markers only cover CHANGED lines, which
    // is a small fraction of the doc, and CM only calls this for rendered lines.
    const marker = state.markers.find((m) => m.line === line);
    return marker ? MARKER_BY_KIND[marker.kind] : null;
  },
  lineMarkerChange(update) {
    return update.startState.field(gitGutterField) !== update.state.field(gitGutterField);
  },
});

/** The full git-gutter extension. Mount once; feed baselines via the effect. */
export function gitGutterExtension(): Extension {
  return [gitGutterField, gitChangeGutter, gitGutterTheme];
}
