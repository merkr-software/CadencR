import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { uiI18n } from "@/lib/i18n/ui";
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

  it("keeps a focused variable and its value when the open dialog changes language", async () => {
    uiI18n.addResourceBundle("fr", "ui", {
      customActions: {
        variables: { title: "Exécuter {{name}}", stillNeeded: "Valeurs requises · {{names}}." },
        run: "Exécuter",
      },
    });
    try {
      render(<RunVariablesDialogHost />);
      act(() =>
        useCustomActionsUiStore
          .getState()
          .openVariablesPrompt({ target, values: {}, showOutput: false }),
      );
      const field = screen.getByLabelText("ENV");
      field.focus();
      fireEvent.change(field, { target: { value: "Équipe Québec" } });
      await act(() => uiI18n.changeLanguage("fr-CA"));
      expect(screen.getByRole("dialog", { name: "Exécuter Deploy" })).toBeVisible();
      expect(screen.getByText("Valeurs requises · REGION.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Exécuter" })).toBeDisabled();
      expect(screen.getByText(action.command)).toBeVisible();
      expect(screen.getByLabelText("ENV")).toBe(field);
      expect(field).toHaveFocus();
      expect(field).toHaveValue("Équipe Québec");
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
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
