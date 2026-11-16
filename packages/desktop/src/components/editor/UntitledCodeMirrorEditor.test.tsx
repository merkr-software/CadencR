import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "@/stores/editor-store";
import UntitledCodeMirrorEditor from "./UntitledCodeMirrorEditor";

vi.mock("./BaseCodeMirrorEditor", () => ({ default: () => null }));
vi.mock("./useSaveAsDialog", () => ({
  useSaveAsDialog: () => ({ saveAs: vi.fn(), isSaving: false }),
}));
vi.mock("./EditorStatusBar", () => ({
  EditorStatusBar: ({ line, col }: { line: number; col: number }) => (
    <output>{`${line}:${col}`}</output>
  ),
}));

describe("UntitledCodeMirrorEditor store snapshots", () => {
  beforeEach(() => useEditorStore.setState({ features: {} }));

  it("renders a stable default cursor when the tab is absent", () => {
    render(
      <UntitledCodeMirrorEditor
        featureId={351}
        projectId={1}
        paneId="main"
        filePath="untitled://missing"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("1:1");
  });

  it("settles after a subscribed tab is removed and still tracks real cursor changes", () => {
    const store = useEditorStore.getState();
    store.initFeature(351);
    const paneId = useEditorStore.getState().features[351].activePaneId;
    const filePath = store.openUntitledBuffer(351, paneId);
    render(
      <UntitledCodeMirrorEditor
        featureId={351}
        projectId={1}
        paneId={paneId}
        filePath={filePath}
      />,
    );

    act(() => store.setCursorPosition(351, paneId, filePath, { line: 7, col: 3 }));
    expect(screen.getByRole("status")).toHaveTextContent("7:3");

    // A subscriber must also tolerate its old props after the store removes its tab.
    act(() => store.closeTab(351, paneId, filePath));
    expect(screen.getByRole("status")).toHaveTextContent("1:1");
  });
});
