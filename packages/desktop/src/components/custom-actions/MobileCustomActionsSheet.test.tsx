import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockCustomAction } from "@/test-fixtures";
import { MobileCustomActionsSheet } from "./MobileCustomActionsSheet";

const launch = vi.hoisted(() => ({
  stopCustomActionRun: vi.fn(async () => {}),
}));
const activateAction = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useFeatureCustomActions", () => ({ useIsActionStarting: () => false }));
vi.mock("@/lib/custom-actions/launch", () => launch);
vi.mock("./useCustomActionsLauncher", () => ({ activateAction }));

const action = createMockCustomAction;

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
        open
        onOpenChange={onOpenChange}
        onShowDetails={vi.fn()}
        details={null}
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

  it("opens a running action's details instead of starting it again", () => {
    const actions = [action(1), action(2, { last_run: running })];
    const onShowDetails = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <MobileCustomActionsSheet
        actions={actions}
        featureId={2}
        projectId={1}
        open
        onOpenChange={onOpenChange}
        onShowDetails={onShowDetails}
        details={null}
      />,
    );

    fireEvent.click(screen.getByText("Action 2"));
    expect(onShowDetails).toHaveBeenCalledWith(2);
    expect(activateAction).not.toHaveBeenCalled();

    // An idle action's details are one tap away too, and the sheet stays open.
    fireEvent.click(screen.getByRole("button", { name: "Details of “Action 1”" }));
    expect(onShowDetails).toHaveBeenLastCalledWith(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows the details page in place of the list", () => {
    render(
      <MobileCustomActionsSheet
        actions={[action(1)]}
        featureId={2}
        projectId={1}
        open
        onOpenChange={vi.fn()}
        onShowDetails={vi.fn()}
        details={<p>Action 1 details</p>}
      />,
    );

    expect(screen.getByText("Action 1 details")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run “Action 1”" })).toBeNull();
  });
  it("hands focus back to the header actions button when it closes", async () => {
    const trigger = document.createElement("button");
    trigger.dataset.phoneMoreTrigger = "";
    document.body.append(trigger);
    const props = {
      actions: [action(1)],
      featureId: 2,
      projectId: 1,
      onOpenChange: vi.fn(),
      onShowDetails: vi.fn(),
      details: null,
    };
    const { rerender } = render(<MobileCustomActionsSheet {...props} open />);
    rerender(<MobileCustomActionsSheet {...props} open={false} />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });
});
