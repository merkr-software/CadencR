import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test-utils";
import { useEditorStore } from "@/stores/editor-store";
import type { useSessionRefs } from "./WebSocketSessionFeatureBlockHooks";

const openFileMutateAsync = vi.fn(async () => undefined);
const startMutateAsync = vi.fn(async () => undefined);

const mocks = vi.hoisted(() => ({
  activateFeatureTab: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/stores/feature-layout-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/stores/feature-layout-store")>();
  return { ...original, activateFeatureTab: mocks.activateFeatureTab };
});
vi.mock("@/hooks/useVimModeLevel", () => ({ useVimModeLevel: vi.fn() }));
vi.mock("@/api/generated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/generated")>();
  return {
    ...actual,
    useOpenFileRoute: () => ({ mutateAsync: openFileMutateAsync }),
    useStartRoute: () => ({ mutateAsync: startMutateAsync }),
  } as never;
});

import { useOpenDiffFileInEditor } from "./WebSocketSessionFeatureBlockLocalHooks";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";

const featureId = 45;
const refs = {
  editor: { current: { focusActiveEditor: vi.fn() } },
} as unknown as ReturnType<typeof useSessionRefs>;

function open() {
  return renderHook(() =>
    useOpenDiffFileInEditor({ featureId, layoutFeatureId: featureId, rootPath: "/repo", refs }),
  );
}

function openWithVimLevel(level: "0" | "1" | "2") {
  vi.mocked(useVimModeLevel).mockReturnValue(level);
  return renderHook(() =>
    useOpenDiffFileInEditor({ featureId, layoutFeatureId: featureId, rootPath: "/repo", refs }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState({ features: {} });
  vi.mocked(useVimModeLevel).mockReturnValue("0");
});

describe("useOpenDiffFileInEditor", () => {
  it("opens a repo-relative file as an ordinary tab and reveals the editor", () => {
    const { result } = open();
    act(() => result.current("/repo/src/conflict.ts", 4));

    const tab = useEditorStore.getState().features[featureId].panes.main.tabs[0];
    expect(tab).toMatchObject({ filePath: "src/conflict.ts", pendingGoToLine: 4 });
    // Resolver mode is derived directly from backend-confirmed Git status,
    // never stored by the open call itself.
    expect(mocks.activateFeatureTab).toHaveBeenCalledWith(featureId, "editor");
  });

  it("focuses an already-open file instead of duplicating the tab", () => {
    const store = useEditorStore.getState();
    store.initFeature(featureId);
    store.openFile(featureId, "main", "src/conflict.ts");
    const { result } = open();
    act(() => result.current("/repo/src/conflict.ts", 9));

    const tabs = useEditorStore.getState().features[featureId].panes.main.tabs;
    expect(tabs.map((tab) => tab.filePath)).toEqual(["src/conflict.ts"]);
    expect(tabs[0].pendingGoToLine).toBe(9);
  });
});

describe("useOpenDiffFileInEditor vim-level routing", () => {
  it("routes to the neovim control socket at vim level 2, starting the session first", async () => {
    const { result } = openWithVimLevel("2");
    await act(async () => result.current("/repo/src/main.rs", 42, 7));
    expect(startMutateAsync).toHaveBeenCalledWith({ data: 45 });
    expect(openFileMutateAsync).toHaveBeenCalledWith({
      featureId: "45",
      data: { path: "src/main.rs", line: 42, col: 7 },
    });
  });

  it("uses the codemirror path at vim level 1, ignoring the column", async () => {
    const { result } = openWithVimLevel("1");
    await act(async () => result.current("/repo/src/main.rs", 42, 7));
    expect(openFileMutateAsync).not.toHaveBeenCalled();
    expect(startMutateAsync).not.toHaveBeenCalled();
    const tab = useEditorStore.getState().features[featureId].panes.main.tabs[0];
    expect(tab).toMatchObject({ filePath: "src/main.rs", pendingGoToLine: 42 });
  });

  it("uses the codemirror path at vim level 0", async () => {
    const { result } = openWithVimLevel("0");
    await act(async () => result.current("/repo/src/main.rs", 3));
    expect(openFileMutateAsync).not.toHaveBeenCalled();
    expect(startMutateAsync).not.toHaveBeenCalled();
  });
});
