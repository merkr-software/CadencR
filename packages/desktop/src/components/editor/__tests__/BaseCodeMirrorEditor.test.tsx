import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@/test-utils";
import { createRef } from "react";
import { tooltips } from "@codemirror/view";
import BaseCodeMirrorEditor from "../BaseCodeMirrorEditor";

const mockDispatch = vi.fn();
const mockDestroy = vi.fn();
const mockFocus = vi.fn();

vi.mock("@codemirror/view", () => {
  class MockEditorView {
    static updateListener = { of: vi.fn(() => []) };
    static domEventHandlers = vi.fn((handlers: unknown) => ({ __handlers: handlers }));
    parent: HTMLElement | null = null;
    dispatch = vi.fn();
    destroy = vi.fn();
    focus = vi.fn();
    state = {
      doc: {
        toString: () => "",
        length: 0,
        lines: 5,
        line: (n: number) => ({ from: (n - 1) * 10, to: (n - 1) * 10 + 9 }),
      },
      selection: { main: { head: 0 } },
    };
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
    tooltips: vi.fn(() => []),
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
  vi.mocked(tooltips).mockClear();
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

    expect(onEditorViewChange).toHaveBeenCalledTimes(1);
    expect(onEditorViewChange).toHaveBeenCalledWith(expect.any(Object));
    unmount();
    expect(onEditorViewChange).toHaveBeenLastCalledWith(null);
  });

  // Regression: in the Frost themes the editor split pane carries its own
  // `backdrop-filter` and becomes a backdrop root, so a tooltip nested inside
  // `.cm-editor` cannot paint its own blur (the LSP symbol-info popover rendered
  // unblurred). Portaling the tooltips to `document.body` lifts them out of the
  // blurred pane so they can frost like every other overlay.
  it("portals CodeMirror tooltips to document.body so Frost blur can paint", () => {
    render(<BaseCodeMirrorEditor />);
    expect(tooltips).toHaveBeenCalledWith({ parent: document.body });
  });

  it("reconfigures when vimMode changes", () => {
    render(<BaseCodeMirrorEditor vimMode={false} />);
  });

  it("reconfigures when readOnly changes", () => {
    render(<BaseCodeMirrorEditor readOnly={true} />);
  });
});
