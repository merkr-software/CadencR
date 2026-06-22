/**
 * Merged LSP diagnostics for an editor running several language servers.
 *
 * The stock flow (`setDiagnostics`) REPLACES the entire lint set, so a linter's
 * publish would clobber the type checker's (and vice-versa). This module keeps
 * a per-server bucket (`Map<lspId, Diagnostic[]>`) in a `StateField`, exposes a
 * `StateEffect` to set one server's bucket, and — on every bucket change — calls
 * `setDiagnostics` with the UNION of all buckets. Each `cadencrServerDiagnostics`
 * dispatches its own bucket effect; the field's update reducer flattens.
 *
 * Mount `mergedDiagnosticsField` once per editor (see `useLsp`). It's keyed by
 * `lspId`, so adding/removing a server only touches that server's bucket.
 */
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Replace one server's diagnostic bucket. `diagnostics: []` clears it. */
export const setServerDiagnostics = StateEffect.define<{
  lspId: string;
  diagnostics: Diagnostic[];
}>();

type DiagnosticBuckets = ReadonlyMap<string, Diagnostic[]>;

/**
 * Per-server diagnostic buckets. The field value is only the source-of-truth
 * map; the actual lint underline set is produced by `setDiagnostics`, dispatched
 * from a side-effecting view plugin below so we never call it inside the field
 * `update` (CodeMirror forbids dispatching during a transaction).
 */
export const mergedDiagnosticsField = StateField.define<DiagnosticBuckets>({
  create: () => new Map(),
  update(buckets, tr) {
    let next: Map<string, Diagnostic[]> | null = null;
    for (const effect of tr.effects) {
      if (effect.is(setServerDiagnostics)) {
        if (!next) next = new Map(buckets);
        if (effect.value.diagnostics.length === 0) {
          next.delete(effect.value.lspId);
        } else {
          next.set(effect.value.lspId, effect.value.diagnostics);
        }
      }
    }
    return next ?? buckets;
  },
});

/** Flatten every bucket into one diagnostic array (sorted by position). */
export function flattenBuckets(buckets: DiagnosticBuckets): Diagnostic[] {
  const all: Diagnostic[] = [];
  for (const bucket of buckets.values()) all.push(...bucket);
  all.sort((a, b) => a.from - b.from || a.to - b.to);
  return all;
}

/**
 * Build the lint transaction spec for the union of all buckets in `state`.
 * Exposed for unit-testing the reducer without a live editor.
 *
 * @public
 */
export function mergedLintTransaction(state: EditorState): ReturnType<typeof setDiagnostics> {
  return setDiagnostics(state, flattenBuckets(state.field(mergedDiagnosticsField)));
}

/**
 * View plugin that, whenever any bucket changes, re-dispatches the flattened
 * union through `setDiagnostics`. Dispatching from `updateListener` (after the
 * bucket transaction commits) keeps us out of the forbidden
 * dispatch-during-update path.
 */
const mergedDiagnosticsSync = EditorView.updateListener.of((update) => {
  const changed = update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(setServerDiagnostics)),
  );
  if (!changed) return;
  update.view.dispatch(mergedLintTransaction(update.view.state));
});

/**
 * The single extension to mount per editor for merged diagnostics: the bucket
 * field plus the sync plugin.
 *
 * @public
 */
export function mergedDiagnostics(): [typeof mergedDiagnosticsField, typeof mergedDiagnosticsSync] {
  return [mergedDiagnosticsField, mergedDiagnosticsSync];
}
