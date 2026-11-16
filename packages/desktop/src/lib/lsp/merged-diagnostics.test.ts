import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import type { Diagnostic } from "@codemirror/lint";
import {
  mergedDiagnostics,
  mergedDiagnosticsField,
  setServerDiagnostics,
  flattenBuckets,
} from "./merged-diagnostics";

function diag(from: number, to: number, message: string): Diagnostic {
  return { from, to, severity: "error", message };
}

function stateWith(): EditorState {
  return EditorState.create({ doc: "abcdefghij", extensions: [mergedDiagnosticsField] });
}

function apply(state: EditorState, lspId: string, diagnostics: Diagnostic[]): EditorState {
  return state.update({ effects: setServerDiagnostics.of({ lspId, diagnostics }) }).state;
}

describe("merged-diagnostics reducer", () => {
  it("keeps each server's diagnostics in its own bucket and unions them", () => {
    let state = stateWith();
    state = apply(state, "tsserver", [diag(0, 1, "type error")]);
    state = apply(state, "eslint", [diag(2, 3, "lint warning")]);

    const merged = flattenBuckets(state.field(mergedDiagnosticsField));
    expect(merged.map((d) => d.message).sort()).toEqual(["lint warning", "type error"]);
  });

  it("one server's update does not clobber another's bucket", () => {
    let state = stateWith();
    state = apply(state, "tsserver", [diag(0, 1, "type error")]);
    state = apply(state, "eslint", [diag(2, 3, "lint warning")]);
    // tsserver re-publishes new diagnostics; eslint's bucket must survive.
    state = apply(state, "tsserver", [diag(4, 5, "new type error")]);

    const merged = flattenBuckets(state.field(mergedDiagnosticsField));
    expect(merged.map((d) => d.message).sort()).toEqual(["lint warning", "new type error"]);
  });

  it("clears a server's bucket when it publishes an empty array", () => {
    let state = stateWith();
    state = apply(state, "tsserver", [diag(0, 1, "type error")]);
    state = apply(state, "eslint", [diag(2, 3, "lint warning")]);
    state = apply(state, "tsserver", []);

    const merged = flattenBuckets(state.field(mergedDiagnosticsField));
    expect(merged.map((d) => d.message)).toEqual(["lint warning"]);
  });

  it("sorts the union by position", () => {
    let state = stateWith();
    state = apply(state, "a", [diag(5, 6, "later")]);
    state = apply(state, "b", [diag(1, 2, "earlier")]);
    const merged = flattenBuckets(state.field(mergedDiagnosticsField));
    expect(merged.map((d) => d.message)).toEqual(["earlier", "later"]);
  });

  it("removes disabled servers and refuses their late diagnostics", () => {
    const servers = new Compartment();
    let state = EditorState.create({
      doc: "abcdefghij",
      extensions: [servers.of(mergedDiagnostics(["typescript", "eslint"]))],
    });
    state = apply(state, "typescript", [diag(0, 1, "type error")]);
    state = apply(state, "eslint", [diag(2, 3, "lint warning")]);
    state = state.update({ effects: servers.reconfigure(mergedDiagnostics(["typescript"])) }).state;
    state = apply(state, "eslint", [diag(4, 5, "late warning")]);
    expect(
      flattenBuckets(state.field(mergedDiagnosticsField)).map((entry) => entry.message),
    ).toEqual(["type error"]);
  });
});
