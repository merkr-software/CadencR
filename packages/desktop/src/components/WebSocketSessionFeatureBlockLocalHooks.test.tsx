import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test-utils";
import { useEditorStore } from "@/stores/editor-store";
import type { useSessionRefs } from "./WebSocketSessionFeatureBlockHooks";

const mocks = vi.hoisted(() => ({
  activateFeatureTab: vi.fn(),
  requestAutoReveal: vi.fn(),
  open: vi.fn(),
  kind: "codemirror",
  preview: vi.fn(),
}));

vi.mock("@/lib/auto-layout/auto-layout-controller", () => ({
  requestAutoReveal: mocks.requestAutoReveal,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/stores/feature-layout-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/stores/feature-layout-store")>();
  return { ...original, activateFeatureTab: mocks.activateFeatureTab };
});
vi.mock("@/hooks/useEditorBackend", () => ({ useEditorBackend: () => ({ kind: mocks.kind }) }));
vi.mock("@/hooks/useOpenEditorFile", () => ({ useOpenEditorFile: () => mocks.open }));
vi.mock("@/lib/open-document-preview", () => ({ openDocumentPreview: mocks.preview }));
import { useOpenDiffFileInEditor } from "./WebSocketSessionFeatureBlockLocalHooks";

const featureId = 45;
const refs = {
  editor: { current: { focusActiveEditor: vi.fn() } },
} as unknown as ReturnType<typeof useSessionRefs>;

function open() {
  return renderHook(
    () =>
      useOpenDiffFileInEditor({ featureId, layoutFeatureId: featureId, rootPath: "/repo", refs })
        .openInPlace,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kind = "codemirror";
  mocks.open.mockImplementation(
    (_path: string, _line?: number, _column?: number, reveal?: () => void) => reveal?.(),
  );
  useEditorStore.setState({ features: {} });
});
describe("diff file navigation", () => {
  it("sends relative paths and exact positions through the selected editor", () => {
    const { result } = open();
    act(() => result.current("/repo/src/main.ts", 42, 7));
    expect(mocks.open).toHaveBeenCalledWith("src/main.ts", 42, 7, expect.any(Function));
    expect(mocks.activateFeatureTab).toHaveBeenCalledWith(featureId, "editor");
  });
  it("keeps binary document preview for external editors", () => {
    mocks.kind = "plugin";
    const { result } = open();
    act(() => result.current("/repo/docs/report.pdf"));
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "docs/report.pdf" }),
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("useOpenDiffFileInEditor beside the agent", () => {
  function openBesideAgent(outcome: string) {
    mocks.requestAutoReveal.mockReturnValue(outcome);
    const store = useEditorStore.getState();
    store.initFeature(featureId);
    return renderHook(
      () =>
        useOpenDiffFileInEditor({ featureId, layoutFeatureId: featureId, rootPath: "/repo", refs })
          .openBesideAgent,
    );
  }

  it("splits the editor in and tucks its tree away", () => {
    const { result } = openBesideAgent("split");
    act(() => result.current("/repo/src/a.ts", 3));
    expect(mocks.requestAutoReveal).toHaveBeenCalledWith(featureId, "editor", "user-link");
    expect(mocks.activateFeatureTab).not.toHaveBeenCalled();
    expect(useEditorStore.getState().features[featureId]).toMatchObject({
      sidebarVisible: false,
      sidebarAutoHidden: true,
    });
  });

  it("leaves a tree the user reopened alone once the editor is already showing", () => {
    const { result } = openBesideAgent("noop");
    act(() => result.current("/repo/src/a.ts"));
    expect(useEditorStore.getState().features[featureId].sidebarVisible).toBe(true);
  });

  it("switches tabs in place when auto layout declines", () => {
    const { result } = openBesideAgent("declined");
    act(() => result.current("/repo/src/a.ts"));
    expect(mocks.activateFeatureTab).toHaveBeenCalledWith(featureId, "editor");
    expect(useEditorStore.getState().features[featureId].sidebarVisible).toBe(true);
  });
});
