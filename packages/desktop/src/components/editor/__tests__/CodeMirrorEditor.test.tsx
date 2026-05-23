import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import CodeMirrorEditor, { clampEditorLineNumber } from "../CodeMirrorEditor";

vi.mock("@codemirror/state", () => ({
  Compartment: class {
    of = vi.fn(() => []);
    reconfigure = vi.fn(() => ({}));
  },
}));

// Mock CodeMirror view — only EditorView is imported directly by CodeMirrorEditor now
vi.mock("@codemirror/view", () => {
  class MockEditorView {
    static updateListener = { of: vi.fn(() => []) };
    destroy = vi.fn();
    dispatch = vi.fn();
    focus = vi.fn();
    state = { doc: { toString: () => "", length: 0 }, selection: { main: { head: 0 } } };
  }
  return {
    EditorView: MockEditorView,
    lineNumbers: vi.fn(() => []),
    highlightActiveLine: vi.fn(() => []),
    drawSelection: vi.fn(() => []),
    keymap: { of: vi.fn(() => []) },
  };
});

const baseEditorProps = vi.fn();

// Mock BaseCodeMirrorEditor to render a simple div with the className
vi.mock("../BaseCodeMirrorEditor", () => ({
  default: ({
    className,
    initialContent,
    editorViewRef,
  }: {
    className?: string;
    initialContent?: string;
    editorViewRef?: React.MutableRefObject<unknown>;
  }) => {
    baseEditorProps({ className, initialContent });
    if (editorViewRef) {
      editorViewRef.current = {
        state: { doc: { toString: () => "", length: 0 } },
        dispatch: vi.fn(),
        destroy: vi.fn(),
      };
    }
    return (
      <div className={className} data-testid="base-editor" data-initial-content={initialContent} />
    );
  },
}));

vi.mock("../language-extensions", () => ({
  getLanguageExtension: vi.fn(() => null),
}));

vi.mock("../editorSaveRegistry", () => ({
  registerSave: vi.fn(),
  unregisterSave: vi.fn(),
}));

vi.mock("../git-blame-extension", () => ({
  gitBlameExtension: vi.fn(() => []),
}));

let mockReadFileReturn: { data: unknown; isLoading: boolean; error: Error | null } = {
  data: undefined,
  isLoading: true,
  error: null,
};

vi.mock("@/api/generated", () => ({
  useReadFile: vi.fn(() => mockReadFileReturn),
  useWriteFile: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useGetBlame: vi.fn(() => ({ data: undefined })),
}));

vi.mock("@/stores/editor-store", () => ({
  useEditorStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setDirty: vi.fn(),
      setCursorPosition: vi.fn(),
      features: {
        1: {
          panes: {
            "pane-1": {
              tabs: [{ filePath: "/test.ts", cursorPosition: { line: 1, col: 1 } }],
            },
          },
        },
      },
    }),
  ),
}));

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: vi.fn(() => ({ value: "false" })),
}));

const defaultProps = {
  filePath: "/test.ts",
  projectId: 42,
  paneId: "pane-1",
  featureId: 1,
};

beforeEach(() => {
  mockReadFileReturn = { data: undefined, isLoading: true, error: null };
  baseEditorProps.mockClear();
});

describe("CodeMirrorEditor", () => {
  it("renders a spinner and does not mount the editor while loading", () => {
    mockReadFileReturn = { data: undefined, isLoading: true, error: null };
    const { container } = render(<CodeMirrorEditor {...defaultProps} />);

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByTestId("base-editor")).not.toBeInTheDocument();
    expect(baseEditorProps).not.toHaveBeenCalled();
  });

  it("renders an error message and does not mount the editor on error", () => {
    mockReadFileReturn = { data: undefined, isLoading: false, error: new Error("Not found") };
    render(<CodeMirrorEditor {...defaultProps} />);

    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.queryByTestId("base-editor")).not.toBeInTheDocument();
    expect(baseEditorProps).not.toHaveBeenCalled();
  });

  it("mounts the editor with initialContent once data is loaded", () => {
    mockReadFileReturn = { data: { content: "hello" }, isLoading: false, error: null };
    const { container } = render(<CodeMirrorEditor {...defaultProps} />);

    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    expect(screen.getByTestId("base-editor")).toBeInTheDocument();
    expect(baseEditorProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialContent: "hello" }),
    );
  });

  it("renders status bar with language and position", () => {
    mockReadFileReturn = { data: { content: "hello" }, isLoading: false, error: null };
    render(<CodeMirrorEditor {...defaultProps} />);

    expect(screen.getByText("Ln 1, Col 1")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("UTF-8")).toBeInTheDocument();
  });

  it("clamps invalid pending go-to lines to the document range", () => {
    expect(clampEditorLineNumber(0, 213)).toBe(1);
    expect(clampEditorLineNumber(-5, 213)).toBe(1);
    expect(clampEditorLineNumber(999, 213)).toBe(213);
    expect(clampEditorLineNumber(10, 213)).toBe(10);
  });
});
