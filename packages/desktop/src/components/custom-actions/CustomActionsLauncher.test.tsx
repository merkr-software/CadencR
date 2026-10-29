import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomAction } from "@/api/generated";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionsLauncher } from "./CustomActionsLauncher";

const listed = vi.hoisted(() => ({ data: [] as CustomAction[], isPending: false }));
const launch = vi.hoisted(() => ({
  launchCustomAction: vi.fn(async () => {}),
  stopCustomActionRun: vi.fn(async () => {}),
  showCustomActionOutput: vi.fn(),
}));

vi.mock("@/hooks/useFeatureCustomActions", () => ({
  useFeatureCustomActions: () => listed,
  useIsActionStarting: () => false,
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useShortcut", () => ({ useGlobalShortcutById: vi.fn() }));
vi.mock("@/lib/custom-actions/launch", () => launch);
vi.mock("./CustomActionsMenu", () => ({ CustomActionsMenu: () => null }));

function action(id: number, overrides: Partial<CustomAction> = {}): CustomAction {
  return {
    id,
    name: `Action ${id}`,
    command: "true",
    created_at: "",
    updated_at: "",
    position: id,
    scope: "project",
    project_id: 1,
    run_in_terminal: false,
    variable_names: [],
    last_run: null,
    ...overrides,
  };
}

describe("CustomActionsLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCustomActionsUiStore.setState({ selectedByProject: {}, editor: null });
  });

  it("offers to create the first action when the project has none", () => {
    listed.data = [];
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "New custom action" }));
    expect(useCustomActionsUiStore.getState().editor).toMatchObject({
      projectId: 1,
      defaultScope: "project",
    });
  });

  it("runs the remembered action, named on the button", () => {
    listed.data = [action(1), action(2)];
    useCustomActionsUiStore.setState({ selectedByProject: { 1: 2 } });
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Run Action 2" }));
    expect(launch.launchCustomAction).toHaveBeenCalledWith({
      action: listed.data[1],
      featureId: 2,
      projectId: 1,
    });
  });

  it("turns into Stop while the selected action runs, and marks the menu", () => {
    const running = { run_id: 8, started_at: "", ended_at: null, exit_code: null };
    listed.data = [action(1, { last_run: running })];
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop Action 1" }));
    expect(launch.stopCustomActionRun).toHaveBeenCalledWith(
      { action: listed.data[0], featureId: 2, projectId: 1 },
      8,
    );
    expect(
      screen.getByRole("button", { name: "Custom actions, an action is running" }),
    ).toBeTruthy();
  });

  it("stays quiet about actions that passed or never ran", () => {
    const passed = { run_id: 8, started_at: "", ended_at: "2026-01-01 00:00:00", exit_code: 0 };
    listed.data = [action(1, { last_run: passed }), action(2)];
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    expect(screen.getByRole("button", { name: "Custom actions" })).toBeTruthy();
  });
});
