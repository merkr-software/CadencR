import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@/test-utils";
import { useDiffKeyboard } from "./useDiffKeyboard";

const mocks = vi.hoisted(() => ({
  shortcutCallbacks: new Map<string, (event: KeyboardEvent) => void>(),
  shortcutOptions: new Map<string, { enabled?: boolean } | undefined>(),
}));

vi.mock("@/hooks/useShortcut", () => ({
  useScopedGlobalShortcutById: (
    id: string,
    callback: (event: KeyboardEvent) => void,
    _scope: string,
    options?: { enabled?: boolean },
  ): void => {
    mocks.shortcutCallbacks.set(id, callback);
    mocks.shortcutOptions.set(id, options);
  },
}));

function Harness({
  focusedFileIndex = 0,
  onOpenFocusedFileInEditor,
}: {
  focusedFileIndex?: number;
  onOpenFocusedFileInEditor?: (filePath: string) => void;
}) {
  useDiffKeyboard({
    fileNames: ["src/a.ts", "src/b.ts"],
    focusedFileIndex,
    setFocusedFileIndex: vi.fn(),
    scrollToFileIndex: vi.fn(),
    toggleFile: vi.fn(),
    blobShas: {},
    viewedFilesSet: new Set(),
    markViewed: { mutate: vi.fn() },
    unmarkViewed: { mutate: vi.fn() },
    featureId: 1,
    diffAreaRef: { current: null },
    setCollapsedFiles: vi.fn(),
    onOpenFocusedFileInEditor,
  });
  return null;
}

describe("useDiffKeyboard", () => {
  beforeEach(() => {
    mocks.shortcutCallbacks.clear();
    mocks.shortcutOptions.clear();
  });

  it("opens the focused file in the editor with the registered shortcut", () => {
    const onOpenFocusedFileInEditor = vi.fn();
    const event = new KeyboardEvent("keydown");
    vi.spyOn(event, "preventDefault");
    vi.spyOn(event, "stopImmediatePropagation");

    render(<Harness focusedFileIndex={1} onOpenFocusedFileInEditor={onOpenFocusedFileInEditor} />);

    mocks.shortcutCallbacks.get("diff-open-focused-file")?.(event);

    expect(onOpenFocusedFileInEditor).toHaveBeenCalledWith("src/b.ts");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(mocks.shortcutOptions.get("diff-open-focused-file")).toEqual({ enabled: true });
  });

  it("does not enable or consume the open shortcut without an editor handler", () => {
    const event = new KeyboardEvent("keydown");
    vi.spyOn(event, "preventDefault");
    vi.spyOn(event, "stopImmediatePropagation");

    render(<Harness focusedFileIndex={1} />);

    mocks.shortcutCallbacks.get("diff-open-focused-file")?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(mocks.shortcutOptions.get("diff-open-focused-file")).toEqual({ enabled: false });
  });
});
