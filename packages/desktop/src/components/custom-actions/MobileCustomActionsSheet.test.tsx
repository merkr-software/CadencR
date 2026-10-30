import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomAction } from "@/api/generated";
import { MobileCustomActionsSheet } from "./MobileCustomActionsSheet";

const launch = vi.hoisted(() => ({
  stopCustomActionRun: vi.fn(async () => {}),
  showCustomActionOutput: vi.fn(),
}));
const activateAction = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useFeatureCustomActions", () => ({ useIsActionStarting: () => false }));
vi.mock("@/lib/custom-actions/launch", () => launch);
vi.mock("./useCustomActionsLauncher", () => ({ activateAction }));

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

const running = { run_id: 8, started_at: "", ended_at: null, exit_code: null };

describe("MobileCustomActionsSheet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs an idle action and stops a running one from its row button", () => {
    const actions = [action(1), action(2, { last_run: running })];
    const onOpenChange = vi.fn();
    render(
      <MobileCustomActionsSheet
        actions={actions}
        featureId={2}
        projectId={1}
        aggregate="running"
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop “Action 2”" }));
    expect(launch.stopCustomActionRun).toHaveBeenCalledWith(
      { action: actions[1], featureId: 2, projectId: 1 },
      8,
    );
    // Stopping keeps the sheet open so the row can be watched settling.
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run “Action 1”" }));
    expect(activateAction).toHaveBeenCalledWith(actions[0], 2, 1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens a running action's output instead of starting it again", () => {
    const actions = [action(2, { last_run: running })];
    render(
      <MobileCustomActionsSheet
        actions={actions}
        featureId={2}
        projectId={1}
        aggregate="running"
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Action 2"));
    expect(launch.showCustomActionOutput).toHaveBeenCalledWith(2, 2);
    expect(activateAction).not.toHaveBeenCalled();
  });
});
