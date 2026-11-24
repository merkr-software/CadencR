import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { act, render, screen } from "@/test-utils";

import { EditorFuzzyShortcut, preloadFileSearch } from "../EditorFuzzyShortcut";

// Capture the callback registered for the `editor-fuzzy` shortcut so the test
// can simulate the CMD+P press without leaning on the real keyboard plumbing.
let registeredCallback: ((e: KeyboardEvent) => void) | null = null;
let registeredEnabled = true;

vi.mock("@/hooks/useShortcut", () => ({
  useGlobalShortcutById: (
    _id: string,
    callback: (e: KeyboardEvent) => void,
    options?: { enabled?: boolean },
  ) => {
    registeredCallback = callback;
    registeredEnabled = options?.enabled ?? true;
  },
}));

let isEditorFocusedMock = true;
vi.mock("@/stores/feature-layout-store", () => ({
  useFeatureLayoutStore: (selector: (s: unknown) => unknown) => selector({}),
  selectFeatureLayout: () => () => ({}),
  getFocusedTab: () => (isEditorFocusedMock ? "editor" : "agent"),
}));

vi.mock("@/components/feature-layout/FeatureLayoutContext", () => ({
  useFeatureLayoutContext: () => ({ featureId: -42, hotkeysEnabled: true }),
}));

vi.mock("../FileSearchDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="file-search-dialog" /> : null,
}));

describe("EditorFuzzyShortcut", () => {
  // As a mouse-driven window does once idle: the picker’s chunk is loaded first.
  beforeAll(async () => {
    await preloadFileSearch();
  });

  beforeEach(() => {
    registeredCallback = null;
    registeredEnabled = true;
    isEditorFocusedMock = true;
  });

  function press(): void {
    const event = new KeyboardEvent("keydown");
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    act(() => registeredCallback?.(event));
  }

  it("does not render the dialog until the shortcut fires", () => {
    render(<EditorFuzzyShortcut featureId={7} projectId={1} />);
    expect(screen.queryByTestId("file-search-dialog")).not.toBeInTheDocument();
  });

  it("opens the dialog when CMD+P fires while the editor tab is focused", () => {
    render(<EditorFuzzyShortcut featureId={7} projectId={1} />);
    press();
    expect(screen.getByTestId("file-search-dialog")).toBeInTheDocument();
  });

  it("ignores the shortcut when the editor tab is not the focused tab", () => {
    isEditorFocusedMock = false;
    render(<EditorFuzzyShortcut featureId={7} projectId={1} />);
    press();
    expect(screen.queryByTestId("file-search-dialog")).not.toBeInTheDocument();
  });

  it("propagates `enabled` to the global shortcut registration", () => {
    render(<EditorFuzzyShortcut featureId={7} projectId={1} enabled={false} />);
    expect(registeredEnabled).toBe(false);
  });
});
