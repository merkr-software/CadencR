import { render } from "@/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "@/stores/editor-store";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import EditorPane from "./EditorPane";

const mode = vi.hoisted(() => ({ level: "2", mobile: false }));
vi.mock("@/hooks/useVimModeLevel", () => ({ useVimModeLevel: () => mode.level }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mode.mobile }));
vi.mock("@/hooks/useShortcut", () => ({ useScopedGlobalShortcutById: vi.fn() }));
vi.mock("./useAutoConflictResolution", () => ({ useActiveConflict: () => null }));
vi.mock("./EditorSubTabs", () => ({ default: () => null }));
vi.mock("./CodeMirrorEditor", () => ({ default: () => null }));
vi.mock("./neovim/NeovimPane", () => ({ default: () => null }));

describe("EditorPane shortcut ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({ features: {} });
    useEditorStore.getState().openFile(1, "main", "file.ts");
    mode.level = "2";
    mode.mobile = false;
  });

  it.each([
    ["2", false, false],
    ["2", true, true],
    ["0", false, true],
  ])("gates CodeMirror shortcuts at level %s on mobile=%s", (level, mobile, enabled) => {
    mode.level = level;
    mode.mobile = mobile;
    render(<EditorPane featureId={1} paneId="main" projectId={1} />);
    for (const id of [
      "editor-new",
      "editor-buffer-search",
      "editor-replace",
      "editor-go-to-line",
      "editor-copy-path",
    ]) {
      const calls = vi
        .mocked(useScopedGlobalShortcutById)
        .mock.calls.filter(([shortcut]) => shortcut === id);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.at(-1)?.[3]?.enabled).toBe(enabled);
    }
  });
});
