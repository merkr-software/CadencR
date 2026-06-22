import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@/test-utils";
import { createRef } from "react";
import BaseCodeMirrorEditor from "../BaseCodeMirrorEditor";

const mockDispatch = vi.fn();
const mockDestroy = vi.fn();
const mockFocus = vi.fn();

vi.mock("@codemirror/view", () => {
  class MockEditorView {
    static updateListener = { of: vi.fn(() => []) };
    parent: HTMLElement | null = null;
    dispatch = mockDispatch;
    destroy = mockDestroy;
    focus = mockFocus;
    state = { doc: { toString: () => "", length: 0 }, selection: { main: { head: 0 } } };
    constructor({ parent }: { parent: HTMLElement }) {
      this.parent = parent;
    }
  }
  return {
    EditorView: MockEditorView,
    lineNumbers: vi.fn(() => []),
    highlightActiveLine: vi.fn(() => []),
    drawSelection: vi.fn(() => []),
    keymap: { of: vi.fn(() => []) },
  };
});

vi.mock("@codemirror/state", () => {
  class MockCompartment {
    of() {
      return [];
    }
    reconfigure() {
      return [];
    }
  }
  return {
    EditorState: {
      create: vi.fn(() => ({})),
      readOnly: { of: vi.fn(() => []) },
      allowMultipleSelections: { of: vi.fn(() => []) },
    },
    Compartment: MockCompartment,
  };
});

vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  history: vi.fn(() => []),
  historyKeymap: [],
}));

vi.mock("@codemirror/language", () => ({
  bracketMatching: vi.fn(() => []),
  indentOnInput: vi.fn(() => []),
}));

vi.mock("@replit/codemirror-vim", () => ({
  vim: vi.fn(() => []),
}));

vi.mock("../editor-theme", () => ({
  cadencrEditorTheme: [],
}));

vi.mock("@/lib/editor/ergonomics-extensions", () => ({
  ergonomicsExtensions: [],
}));

beforeEach(() => {
  mockDispatch.mockClear();
  mockDestroy.mockClear();
  mockFocus.mockClear();
});

describe("BaseCodeMirrorEditor", () => {
  it("renders a container div with the given className", () => {
    const { container } = render(<BaseCodeMirrorEditor className="my-editor" />);
    expect(container.querySelector(".my-editor")).toBeInTheDocument();
  });

  it("uses default className when none provided", () => {
    const { container } = render(<BaseCodeMirrorEditor />);
    expect(container.querySelector(".h-full.overflow-auto")).toBeInTheDocument();
  });

  it("exposes EditorView via editorViewRef", () => {
    const ref = createRef<unknown>();
    render(<BaseCodeMirrorEditor editorViewRef={ref as React.MutableRefObject<null>} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current).toHaveProperty("dispatch");
    expect(ref.current).toHaveProperty("focus");
  });

  it("cleans up EditorView on unmount", () => {
    const { unmount } = render(<BaseCodeMirrorEditor />);
    unmount();
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it("nulls editorViewRef on unmount", () => {
    const ref = createRef<unknown>();
    const { unmount } = render(
      <BaseCodeMirrorEditor editorViewRef={ref as React.MutableRefObject<null>} />,
    );
    expect(ref.current).not.toBeNull();
    unmount();
    expect(ref.current).toBeNull();
  });

  it("notifies when EditorView mounts and unmounts", () => {
    const onEditorViewChange = vi.fn();
    const { unmount } = render(<BaseCodeMirrorEditor onEditorViewChange={onEditorViewChange} />);

    expect(onEditorViewChange).toHaveBeenCalledWith(expect.objectContaining({ focus: mockFocus }));
    unmount();
    expect(onEditorViewChange).toHaveBeenLastCalledWith(null);
  });

  it("dispatches reconfigure when vimMode changes", () => {
    const { rerender } = render(<BaseCodeMirrorEditor vimMode={false} />);
    mockDispatch.mockClear();
    rerender(<BaseCodeMirrorEditor vimMode={true} />);
    expect(mockDispatch).toHaveBeenCalled();
  });

  it("dispatches reconfigure when readOnly changes", () => {
    const { rerender } = render(<BaseCodeMirrorEditor readOnly={false} />);
    mockDispatch.mockClear();
    rerender(<BaseCodeMirrorEditor readOnly={true} />);
    expect(mockDispatch).toHaveBeenCalled();
  });
});
