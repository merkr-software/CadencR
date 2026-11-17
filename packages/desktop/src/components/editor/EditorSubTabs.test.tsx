// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "@/stores/editor-store";
import EditorSubTabs from "./EditorSubTabs";

const FEATURE = 41;
const PANE = "main";

describe("EditorSubTabs names", () => {
  beforeEach(() => {
    act(() => {
      useEditorStore.setState({ features: {} });
      useEditorStore.getState().initFeature(FEATURE);
      useEditorStore.getState().openFile(FEATURE, PANE, "dir/a\nb.txt");
    });
  });

  it("shows a name holding a newline escaped the way git prints it", () => {
    render(<EditorSubTabs featureId={FEATURE} paneId={PANE} projectId={1} />);
    expect(screen.getByText('"a\\nb.txt"')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'Close "a\\nb.txt"' })).toBeInTheDocument();
  });

  it("escapes a disambiguated folder/name the same way", () => {
    act(() => useEditorStore.getState().openFile(FEATURE, PANE, "other/a\nb.txt"));
    render(<EditorSubTabs featureId={FEATURE} paneId={PANE} projectId={1} />);
    expect(screen.getByText('dir/"a\\nb.txt"')).toBeInTheDocument();
    expect(screen.getByText('other/"a\\nb.txt"')).toBeInTheDocument();
  });

  it("names the escaped file in the unsaved-changes dialog", () => {
    act(() => useEditorStore.getState().setDirty(FEATURE, PANE, "dir/a\nb.txt", true));
    render(<EditorSubTabs featureId={FEATURE} paneId={PANE} projectId={1} />);
    fireEvent.click(screen.getByRole("button", { name: 'Close "a\\nb.txt"' }));
    expect(screen.getByRole("dialog")).toHaveTextContent('unsaved changes in "a\\nb.txt"');
  });
});
