// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomAction } from "@/api/generated";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import {
  announceFinishedRun,
  launchCustomAction,
  missingVariables,
  saveVariablesAndLaunch,
  showCustomActionOutput,
} from "./launch";

const api = vi.hoisted(() => ({
  runCustomAction: vi.fn(async () => ({ run_id: 21 })),
  resolveCommand: vi.fn(async () => ({ command: "pnpm dev", cwd: "/w" })),
  setCustomActionVariable: vi.fn(async () => ({ success: true })),
  getCustomActionRuns: vi.fn(async () => [{ id: 21, exit_code: 0 }]),
  cancelCustomActionRun: vi.fn(),
  storedVariables: [] as Array<{ var_name: string; value: string }>,
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
const sendToTerminal = vi.hoisted(() => vi.fn());
const activateFeatureTab = vi.hoisted(() => vi.fn());
const viewing = vi.hoisted(() => ({ featureId: 2 }));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/api/generated", () => ({
  runCustomAction: api.runCustomAction,
  resolveCommand: api.resolveCommand,
  setCustomActionVariable: api.setCustomActionVariable,
  getCustomActionRuns: api.getCustomActionRuns,
  cancelCustomActionRun: api.cancelCustomActionRun,
  getGetCustomActionVariablesQueryOptions: () => ({
    queryKey: ["vars"],
    queryFn: async () => api.storedVariables,
  }),
  getGetCustomActionVariablesQueryKey: () => ["vars"],
  getGetCustomActionRunsQueryKey: () => ["runs"],
  getListCustomActionsQueryKey: () => ["list"],
  getListFeatureActivityQueryKey: () => ["activity"],
}));
vi.mock("@/hooks/useTerminalState", () => ({
  useTerminalStore: { getState: () => ({ sendToTerminal }) },
}));
vi.mock("@/stores/feature-layout-store", () => ({ activateFeatureTab }));
vi.mock("@/lib/notify-agent-done", () => ({
  isViewingFeature: (featureId: number) => featureId === viewing.featureId,
}));
vi.mock("@/router", () => ({ router }));
vi.mock("@/components/project-feature-navigation", () => ({
  navigateToFeatureIdOrHome: (
    navigate: typeof router.navigate,
    projectId: number,
    featureId: number,
  ) => navigate({ projectId, featureId }),
}));

function action(overrides: Partial<CustomAction> = {}): CustomAction {
  return {
    id: 5,
    name: "Deploy",
    command: "deploy ${ENV}",
    created_at: "",
    updated_at: "",
    position: 0,
    scope: "project",
    project_id: 1,
    run_in_terminal: false,
    variable_names: ["ENV"],
    last_run: null,
    ...overrides,
  };
}

describe("launchCustomAction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    api.storedVariables = [];
    const { queryClient } = await import("@/lib/queryClient");
    queryClient.clear();
    useCustomActionsUiStore.setState({
      pendingVariables: null,
      trackedRuns: {},
      starting: {},
      menu: null,
    });
  });

  it("lists variables without a value, blanks included", () => {
    expect(missingVariables(["A", "B", "C"], { A: "x", B: "  " })).toEqual(["B", "C"]);
  });

  it("asks for missing values instead of starting a run that would fail", async () => {
    await launchCustomAction({ action: action(), featureId: 2, projectId: 1 });
    expect(api.runCustomAction).not.toHaveBeenCalled();
    expect(useCustomActionsUiStore.getState().pendingVariables?.values).toEqual({});
  });

  it("runs straight away when every value is stored, and tracks the run", async () => {
    api.storedVariables = [{ var_name: "ENV", value: "staging" }];
    await launchCustomAction({ action: action(), featureId: 2, projectId: 1 });
    expect(api.runCustomAction).toHaveBeenCalledWith(5, { feature_id: 2 });
    expect(useCustomActionsUiStore.getState().trackedRuns[21]).toMatchObject({ actionId: 5 });
    expect(useCustomActionsUiStore.getState().starting).toEqual({});
  });

  it("reopens the action's details once a run asked from them starts", async () => {
    await launchCustomAction(
      { action: action({ variable_names: [] }), featureId: 2, projectId: 1 },
      { showOutput: true },
    );
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 2, actionId: 5 });
  });

  it("closes the menu under the variables dialog, carrying the details request", async () => {
    api.storedVariables = [{ var_name: "ENV", value: "staging" }];
    useCustomActionsUiStore.getState().openMenu(2, 5);
    await launchCustomAction(
      { action: action(), featureId: 2, projectId: 1 },
      { promptVariables: true, showOutput: true },
    );
    const prompt = useCustomActionsUiStore.getState().pendingVariables;
    expect(prompt).toMatchObject({ values: { ENV: "staging" }, showOutput: true });
    expect(useCustomActionsUiStore.getState().menu).toBeNull();
  });

  it("saves only edited values before running", async () => {
    await saveVariablesAndLaunch(
      { action: action({ variable_names: ["ENV", "REGION"] }), featureId: 2, projectId: 1 },
      { ENV: "prod", REGION: "eu" },
      { ENV: "staging", REGION: "eu" },
    );
    expect(api.setCustomActionVariable).toHaveBeenCalledExactlyOnceWith(
      5,
      { var_name: "ENV", value: "prod" },
      { feature_id: 2 },
    );
    expect(api.runCustomAction).toHaveBeenCalledOnce();
  });

  it("sends a terminal action to a terminal split", async () => {
    await launchCustomAction({
      action: action({ run_in_terminal: true, variable_names: [] }),
      featureId: 2,
      projectId: 1,
    });
    expect(sendToTerminal).toHaveBeenCalledWith(2, "pnpm dev\n");
    expect(activateFeatureTab).toHaveBeenCalledWith(2, "terminal");
    expect(api.runCustomAction).not.toHaveBeenCalled();
  });

  it("surfaces the backend's refusal", async () => {
    api.runCustomAction.mockRejectedValueOnce(new Error("Feature has no working directory yet"));
    await launchCustomAction({
      action: action({ variable_names: [] }),
      featureId: 2,
      projectId: 1,
    });
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Feature has no working directory yet"),
    );
  });

  it("announces the end of a run started here, once", async () => {
    useCustomActionsUiStore
      .getState()
      .trackRun(21, { actionId: 5, actionName: "Deploy", featureId: 2, projectId: 1 });
    await announceFinishedRun(21);
    await announceFinishedRun(21);
    expect(toast.success).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Deploy passed", expect.anything());
  });

  it("opens the menu on the action's details from the finished-run toast", async () => {
    useCustomActionsUiStore
      .getState()
      .trackRun(21, { actionId: 5, actionName: "Deploy", featureId: 2, projectId: 1 });
    await announceFinishedRun(21);
    const options = toast.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    options.action.onClick();
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 2, actionId: 5 });
  });

  it("opens the details in place when the conversation is already shown", () => {
    showCustomActionOutput({ featureId: 2, projectId: 1, actionId: 5 });
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 2, actionId: 5 });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("goes to another conversation to show its action's details", async () => {
    showCustomActionOutput({ featureId: 3, projectId: 1, actionId: 5 });
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 3, actionId: 5 });
    await vi.waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({ projectId: 1, featureId: 3 }),
    );
  });
});
