import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomAction } from "@/api/generated";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { RunVariablesDialogHost } from "./RunVariablesDialog";

const saveVariablesAndLaunch = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/custom-actions/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/custom-actions/launch")>()),
  saveVariablesAndLaunch,
}));

const action: CustomAction = {
  id: 5,
  name: "Deploy",
  command: "deploy ${ENV} ${REGION}",
  created_at: "",
  updated_at: "",
  position: 0,
  scope: "project",
  project_id: 1,
  run_in_terminal: false,
  variable_names: ["ENV", "REGION"],
  last_run: null,
};
const target = { action, featureId: 2, projectId: 1 };

describe("RunVariablesDialog", () => {
  beforeEach(() => {
    saveVariablesAndLaunch.mockClear();
    useCustomActionsUiStore.setState({ pendingVariables: null });
  });

  it("keeps Run disabled until every value is filled, then saves and runs", async () => {
    render(<RunVariablesDialogHost />);
    act(() =>
      useCustomActionsUiStore
        .getState()
        .openVariablesPrompt({ target, values: { ENV: "prod" }, showOutput: false }),
    );

    const run = screen.getByRole("button", { name: "Run" });
    expect((screen.getByLabelText("ENV") as HTMLInputElement).value).toBe("prod");
    expect(run).toHaveProperty("disabled", true);
    expect(screen.getByText(/Still needed: REGION/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("REGION"), { target: { value: "eu" } });
    expect(run).toHaveProperty("disabled", false);
    fireEvent.click(run);

    await waitFor(() =>
      expect(saveVariablesAndLaunch).toHaveBeenCalledWith(
        target,
        { ENV: "prod", REGION: "eu" },
        { ENV: "prod" },
        false,
      ),
    );
    await waitFor(() => expect(useCustomActionsUiStore.getState().pendingVariables).toBeNull());
  });
});
