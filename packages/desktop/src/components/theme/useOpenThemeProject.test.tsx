import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserTheme } from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import { DEFAULT_PANE_ID } from "@/stores/editor-helpers";
import { useEditorStore } from "@/stores/editor-store";
import { findPaneContaining, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { useOpenThemeProject } from "./useOpenThemeProject";

const navigate = vi.hoisted(() => vi.fn());
const workspace = vi.hoisted(() => vi.fn());
const setFeatureSetting = vi.hoisted(() => vi.fn());
const themeState = vi.hoisted(() => ({
  followSystemTheme: false,
  setTheme: vi.fn(),
  setSystemLightTheme: vi.fn(),
  setSystemDarkTheme: vi.fn(),
}));
const systemAppearance = vi.hoisted(() => ({ value: "dark" as "light" | "dark" }));

vi.mock("@/hooks/useOpenEditorFile", () => ({
  useEditorFileNavigator: () => (featureId: number, params: { path: string }) =>
    useEditorStore.getState().openFile(featureId, DEFAULT_PANE_ID, params.path),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/api/generated", () => ({
  useThemeWorkspace: () => ({ mutateAsync: workspace }),
  useSetFeatureSetting: () => ({ mutateAsync: setFeatureSetting }),
  getGetFeatureSettingsQueryKey: (id: number) => [`/api/features/${id}/settings`],
}));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => themeState }));
vi.mock("@/hooks/useSystemAppearance", () => ({
  useSystemAppearance: () => ({ appearance: systemAppearance.value, error: null }),
}));

function theme(overrides: Partial<UserTheme> = {}): UserTheme {
  return {
    id: "vamp",
    path: "/themes/vamp/theme.json",
    content: "{}",
    label: "Vamp",
    theme: { label: "Vamp", appearance: "dark", cssVars: {}, xterm: {} },
    issues: [],
    ...overrides,
  } as UserTheme;
}

function renderOpen() {
  const client = createTestQueryClient();
  return renderHook(() => useOpenThemeProject(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  themeState.followSystemTheme = false;
  systemAppearance.value = "dark";
  setFeatureSetting.mockResolvedValue(undefined);
  useEditorStore.setState({ features: {} });
  useFeatureLayoutStore.setState({ features: {} });
  workspace.mockResolvedValue({
    project_id: 7,
    feature_id: 12,
    cwd: "/themes/vamp",
    created: false,
  });
});

function openTabs(featureId: number): string[] {
  const pane = useEditorStore.getState().features[featureId]?.panes[DEFAULT_PANE_ID];
  return pane?.tabs.map((tab) => tab.filePath) ?? [];
}

describe("useOpenThemeProject", () => {
  it("goes to the theme's own project", async () => {
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "7", featureId: "12" },
    });
  });

  it("uses the workspace returned by creation without a second project request", async () => {
    const { result } = renderOpen();
    result.current.open(theme(), {
      project_id: 7,
      feature_id: 12,
      cwd: "/themes/vamp",
      created: true,
    });

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(workspace).not.toHaveBeenCalled();
    expect(setFeatureSetting).toHaveBeenCalledTimes(1);
    expect(openTabs(12)).toEqual(["theme.json"]);
  });

  it("puts the theme on, so editing it is visible everywhere", async () => {
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(themeState.setTheme).toHaveBeenCalledWith("user:vamp"));
  });

  it("fills the matching system slot when the user follows their system", async () => {
    themeState.followSystemTheme = true;
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(themeState.setSystemDarkTheme).toHaveBeenCalledWith("user:vamp"));
    expect(themeState.setTheme).not.toHaveBeenCalled();
    expect(themeState.setSystemLightTheme).not.toHaveBeenCalled();
  });

  it("opens a broken theme without trying to wear it", async () => {
    const { result } = renderOpen();
    result.current.open(theme({ theme: null, issues: [{ token: null, message: "bad" }] }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(themeState.setTheme).not.toHaveBeenCalled();
  });

  it("puts the theme file in the editor", async () => {
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(openTabs(12)).toEqual(["theme.json"]));
  });

  it("splits the first open so the file and the agent sit together", async () => {
    workspace.mockResolvedValue({
      project_id: 7,
      feature_id: 12,
      cwd: "/themes/vamp",
      created: true,
    });
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(setFeatureSetting).toHaveBeenCalled());
    const layout = useFeatureLayoutStore.getState().features[12];
    expect(layout?.splitRoot.type).toBe("split");
    expect(findPaneContaining(layout!.splitRoot, "editor")?.id).not.toBe(
      findPaneContaining(layout!.splitRoot, "agent")?.id,
    );
    // Saved, not just applied: layout persistence treats the first state it
    // sees as the baseline and would never write this one back.
    expect(setFeatureSetting).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, data: expect.objectContaining({ key: "layout_state" }) }),
    );
  });

  it("leaves the panes alone on every open after the first", async () => {
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(setFeatureSetting).not.toHaveBeenCalled();
    expect(useFeatureLayoutStore.getState().features[12]).toBeUndefined();
  });

  it("stays put when the project can't be opened", async () => {
    workspace.mockRejectedValue(new Error("nope"));
    const { result } = renderOpen();
    result.current.open(theme());

    await waitFor(() => expect(result.current.openingId).toBeNull());
    expect(navigate).not.toHaveBeenCalled();
    expect(themeState.setTheme).not.toHaveBeenCalled();
  });
});
