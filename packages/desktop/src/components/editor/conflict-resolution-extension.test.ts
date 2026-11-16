// @vitest-environment happy-dom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { applyConflictChoice, buildConflictHunks } from "./conflict-resolution-adapter";
import { conflictResolutionControls } from "./conflict-resolution-extension";

const result = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nafter\n";

describe("conflictResolutionControls", () => {
  it("renders operation-aware actions inside CodeMirror and keeps them one-step undoable", () => {
    const hunks = buildConflictHunks(result);
    let view: EditorView;
    view = new EditorView({
      state: EditorState.create({
        doc: result,
        extensions: [
          history(),
          conflictResolutionControls({
            hunks,
            currentLabel: "Current branch",
            incomingLabel: "Incoming branch",
            onApply: (hunk, choice) => {
              applyConflictChoice(view, hunk, choice);
            },
          }),
        ],
      }),
    });

    const incoming = [...view.dom.querySelectorAll("button")].find(
      (button) => button.textContent === "Accept Incoming branch",
    );
    const current = [...view.dom.querySelectorAll("button")].find(
      (button) => button.textContent === "Accept Current branch",
    );
    expect(view.dom.querySelectorAll(".cm-conflictCurrentLine")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".cm-conflictIncomingLine")).toHaveLength(1);
    expect(view.dom.querySelector(".cm-conflictCurrentMarker")).not.toBeNull();
    expect(view.dom.querySelector(".cm-conflictIncomingMarker")).not.toBeNull();
    expect(current).toHaveAttribute("data-choice", "current");
    expect(incoming).toHaveAttribute("data-choice", "incoming");
    expect(incoming).toBeInstanceOf(HTMLButtonElement);
    incoming?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(view.state.doc.toString()).toBe("before\ntheirs\nafter\n");
    expect(view.dom.querySelector(".cm-conflictActions")).toBeNull();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(result);
    expect(view.dom.querySelector(".cm-conflictActions")).not.toBeNull();
    view.destroy();
  });

  it("removes unsafe controls after an overlapping manual edit", () => {
    const hunks = buildConflictHunks(result);
    const view = new EditorView({
      state: EditorState.create({
        doc: result,
        extensions: [
          conflictResolutionControls({
            hunks,
            currentLabel: "Current branch",
            incomingLabel: "Incoming branch",
            onApply: () => undefined,
          }),
        ],
      }),
    });
    expect(view.dom.querySelector(".cm-conflictActions")).not.toBeNull();

    const from = view.state.doc.toString().indexOf("ours");
    view.dispatch({ changes: { from, to: from + 4, insert: "manual" } });

    expect(view.dom.querySelector(".cm-conflictActions")).toBeNull();
    view.destroy();
  });

  it("explains an ambiguous hunk inline instead of offering a risky action", () => {
    const hunks = buildConflictHunks(result);
    const view = new EditorView({
      state: EditorState.create({
        doc: `${result}${hunks[0].markerText}`,
        extensions: [
          conflictResolutionControls({
            hunks,
            currentLabel: "Current branch",
            incomingLabel: "Incoming branch",
            onApply: () => undefined,
          }),
        ],
      }),
    });

    const actions = view.dom.querySelector(".cm-conflictActions");
    expect(actions?.classList.contains("cm-conflictActions-disabled")).toBe(true);
    expect(view.dom.querySelectorAll(".cm-conflictActionButton")).toHaveLength(0);
    expect(view.dom.querySelector(".cm-conflictActionsReason")?.textContent).toMatch(/ambiguous/);
    view.destroy();
  });
});
