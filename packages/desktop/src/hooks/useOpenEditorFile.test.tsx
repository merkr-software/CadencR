import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorTarget } from "@/lib/editors/editor-registry";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";
import { editorSurfaces } from "@/lib/editors/editor-surfaces";
import { useEditorNavigationStore } from "@/lib/editors/editor-navigation-store";
import { useEditorStore } from "@/stores/editor-store";
import { createTestQueryClient } from "@/test-utils";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  loading: vi.fn(() => "pending"),
  dismiss: vi.fn(),
  error: vi.fn(),
  maxTabs: "10",
  nativeOpen: vi.fn(),
  nativeFocus: vi.fn(),
}));
vi.mock("@/lib/editors/editor-query", () => ({ readEditorTarget: mocks.read }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: () => ({ value: mocks.maxTabs }),
}));
vi.mock("@/components/editor/neovim/editor-adapter", () => ({
  builtinNeovimEditor: { open: mocks.nativeOpen, focus: mocks.nativeFocus },
}));
vi.mock("sonner", () => ({
  toast: { loading: mocks.loading, dismiss: mocks.dismiss, error: mocks.error },
}));
import { useOpenEditorFile } from "./useOpenEditorFile";
const releases: (() => void)[] = [];
const plugin = pluginTabSummary({
  id: "example",
  editor: { label: "Editor", open_method: "files.open" },
});
const external: EditorTarget = { kind: "plugin", id: "plugin:example", plugin };
function setup(target: EditorTarget = external) {
  mocks.read.mockResolvedValue(target);
  const client = createTestQueryClient();
  client.setQueryData(getGetWorkspaceSettingQueryKey("editor_backend"), { value: target.id });
  const hook = renderHook(() => useOpenEditorFile(7), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.maxTabs = "10";
  useEditorStore.setState({ features: {} });
  useEditorNavigationStore.setState({ engaged: {}, opened: {}, fallbacks: {} });
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
});
describe("shared file opener", () => {
  it("shows a catalog error on the first opening before editor settings are cached", async () => {
    const { result, client } = setup();
    client.removeQueries({ queryKey: getGetWorkspaceSettingQueryKey("editor_backend") });
    mocks.read.mockImplementationOnce(
      async (
        _client: unknown,
        _featureId: number,
        _environment: unknown,
        selected: (id: string) => void,
      ) => {
        client.setQueryData(getGetWorkspaceSettingQueryKey("editor_backend"), {
          value: external.id,
        });
        selected(external.id);
        throw new Error("Catalog unavailable");
      },
    );
    act(() => result.current("first.ts", 2, 3));
    await waitFor(() =>
      expect(useEditorNavigationStore.getState().fallbacks[7]?.reason).toContain(
        "Catalog unavailable",
      ),
    );
    expect(useEditorStore.getState().features[7].panes.main.tabs[0].filePath).toBe("first.ts");
  });
  it("shows a fallback when the selected plugin catalog cannot be fetched", async () => {
    const { result } = setup();
    mocks.read.mockRejectedValueOnce(new Error("Catalog unavailable"));
    act(() => result.current("main.ts", 2, 3));
    await waitFor(() =>
      expect(useEditorNavigationStore.getState().fallbacks[7]?.reason).toContain(
        "Catalog unavailable",
      ),
    );
    expect(useEditorStore.getState().features[7].panes.main.tabs[0]).toMatchObject({
      filePath: "main.ts",
      pendingGoToColumn: 3,
    });
    expect(mocks.error).toHaveBeenCalled();
  });
  it("records and focuses a plugin file only after the backend acknowledges it", async () => {
    let acknowledge!: (value: { result: null }) => void;
    const backend = vi.fn(
      () =>
        new Promise<{ result: null }>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const focus = vi.fn();
    releases.push(editorSurfaces.register("7:editor:example", { requestBackend: backend, focus }));
    const { result } = setup();
    act(() => result.current("src/main.ts", 42, 7));
    await waitFor(() =>
      expect(backend).toHaveBeenCalledWith("files.open", {
        path: "src/main.ts",
        line: 42,
        column: 7,
      }),
    );
    expect(focus).not.toHaveBeenCalled();
    expect(useEditorStore.getState().features[7]).toBeUndefined();
    expect(useEditorNavigationStore.getState().opened[7]).toBeUndefined();
    await act(async () => acknowledge({ result: null }));
    expect(focus).toHaveBeenCalledOnce();
    expect(useEditorNavigationStore.getState().opened[7]).toMatchObject({
      backendId: "plugin:example",
      params: { line: 42, column: 7 },
    });
    expect(mocks.dismiss).toHaveBeenCalledWith("pending");
  });
  it("preserves line and column in CodeMirror, and honours unlimited tabs", async () => {
    mocks.maxTabs = "0";
    const { result } = setup({ kind: "codemirror", id: "codemirror" });
    act(() => result.current("one.ts", 42, 7));
    await waitFor(() =>
      expect(useEditorStore.getState().features[7]?.panes.main.tabs).toHaveLength(1),
    );
    act(() => result.current("two.ts"));
    await waitFor(() =>
      expect(useEditorStore.getState().features[7]?.panes.main.tabs).toHaveLength(2),
    );
    expect(useEditorStore.getState().features[7].panes.main.tabs[0]).toMatchObject({
      pendingGoToLine: 42,
      pendingGoToColumn: 7,
    });
  });
  it("opens a visible CodeMirror fallback on a backend refusal, without automatic replay", async () => {
    const backend = vi.fn().mockResolvedValue({ error: { code: "REFUSED", message: "Denied" } });
    releases.push(
      editorSurfaces.register("7:editor:example", { requestBackend: backend, focus: vi.fn() }),
    );
    const { result } = setup();
    act(() => result.current("main.ts", 2, 3));
    await waitFor(() =>
      expect(useEditorNavigationStore.getState().fallbacks[7]?.reason).toContain("Denied"),
    );
    expect(useEditorStore.getState().features[7].panes.main.tabs[0]).toMatchObject({
      filePath: "main.ts",
      pendingGoToColumn: 3,
    });
    expect(backend).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalled();
  });
  it("ignores a delayed response after a confirmed editor-setting change", async () => {
    let acknowledge!: (value: { result: null }) => void;
    const backend = vi.fn(
      () =>
        new Promise<{ result: null }>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const focus = vi.fn();
    releases.push(editorSurfaces.register("7:editor:example", { requestBackend: backend, focus }));
    const { result, client } = setup();
    act(() => result.current("old.ts"));
    await waitFor(() => expect(backend).toHaveBeenCalled());
    client.setQueryData(getGetWorkspaceSettingQueryKey("editor_backend"), { value: "codemirror" });
    await act(async () => acknowledge({ result: null }));
    expect(focus).not.toHaveBeenCalled();
    expect(useEditorNavigationStore.getState().opened[7]).toBeUndefined();
  });
});
