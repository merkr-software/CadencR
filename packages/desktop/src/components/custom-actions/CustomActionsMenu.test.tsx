import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { uiI18n } from "@/lib/i18n/ui";
import type { CustomAction } from "@/api/generated";
import { createMockCustomAction } from "@/test-fixtures";
import { CustomActionsMenu } from "./CustomActionsMenu";

const activateAction = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/useOpenScheduleEditorForAction", () => ({
  useOpenScheduleEditorForAction: () => vi.fn(),
}));
vi.mock("@/lib/shortcuts/overrides", () => ({
  useResolvedShortcut: () => ({ keys: ["Alt", "Meta", "1"] }),
}));
vi.mock("@/lib/custom-actions/launch", () => ({ launchCustomAction: vi.fn() }));
vi.mock("./useCustomActionsLauncher", () => ({ activateAction }));

const action = createMockCustomAction;

function renderMenu(actions: CustomAction[]) {
  const onDone = vi.fn();
  const onShowDetails = vi.fn();
  render(
    <CustomActionsMenu
      actions={actions}
      selected={actions[0] ?? null}
      featureId={2}
      projectId={1}
      onDone={onDone}
      onShowDetails={onShowDetails}
    />,
  );
  return { onDone, onShowDetails };
}

describe("CustomActionsMenu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds translated commands with a query already entered in the open menu", async () => {
    uiI18n.addResourceBundle("fr", "ui", {
      customActions: { customActionsMenu: { manageActions: "Gérer les actions…" } },
    });
    try {
      renderMenu([action(1)]);
      const input = screen.getByLabelText("Filter actions");
      input.focus();
      fireEvent.change(input, { target: { value: "gérer" } });
      expect(screen.queryByText("Manage actions…")).toBeNull();
      await act(() => uiI18n.changeLanguage("fr"));
      expect(await screen.findByText("Gérer les actions…")).toBeVisible();
      expect(input).toHaveValue("gérer");
      expect(input).toHaveFocus();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });

  it("opens an action's details from its chevron without running it", () => {
    const { onDone, onShowDetails } = renderMenu([action(1), action(2)]);
    fireEvent.click(screen.getByTestId("details-2"));
    expect(onShowDetails).toHaveBeenCalledWith(2);
    expect(activateAction).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("opens the highlighted action's details with →", () => {
    const { onShowDetails } = renderMenu([action(1), action(2)]);
    const input = screen.getByLabelText("Filter actions");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onShowDetails).toHaveBeenCalledWith(2);
  });

  it("runs an action on select, closing the menu", () => {
    const actions = [action(1)];
    const { onDone } = renderMenu(actions);
    fireEvent.click(screen.getByText("Action 1"));
    expect(onDone).toHaveBeenCalled();
    expect(activateAction).toHaveBeenCalledWith(actions[0], 2, 1);
  });

  it("offers the selected action's output and runs", () => {
    const { onShowDetails } = renderMenu([action(1)]);
    fireEvent.click(screen.getByText("Output and runs of Action 1"));
    expect(onShowDetails).toHaveBeenCalledWith(1);
  });
});
