import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomAction } from "@/api/generated";
import { createMockCustomAction } from "@/test-fixtures";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionsLauncher } from "./CustomActionsLauncher";

const listed = vi.hoisted(() => ({ data: [] as CustomAction[], isPending: false }));
const launch = vi.hoisted(() => ({
  launchCustomAction: vi.fn(async () => {}),
  stopCustomActionRun: vi.fn(async () => {}),
  showCustomActionOutput: vi.fn(),
}));
const menuProps = vi.hoisted(() => ({ onShowDetails: null as ((id: number) => void) | null }));

vi.mock("@/hooks/useFeatureCustomActions", () => ({
  useFeatureCustomActions: () => listed,
  useIsActionStarting: () => false,
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useShortcut", () => ({ useGlobalShortcutById: vi.fn() }));
vi.mock("@/lib/custom-actions/launch", () => launch);
vi.mock("./CustomActionsMenu", () => ({
  CustomActionsMenu: (props: { onShowDetails: (id: number) => void }) => {
    menuProps.onShowDetails = props.onShowDetails;
    return <p>Action list</p>;
  },
}));
vi.mock("./DeleteCustomActionDialog", () => ({
  DeleteCustomActionDialog: (props: { action: CustomAction | null }) =>
    props.action && <p>Delete {props.action.name}?</p>,
}));
vi.mock("./CustomActionDetails", () => ({
  CustomActionDetails: (props: {
    action: CustomAction;
    onBack: () => void;
    onLeave: () => void;
    onDelete: (action: CustomAction) => void;
  }) => (
    <>
      <button type="button" onClick={props.onBack}>
        {props.action.name} details
      </button>
      <button
        type="button"
        onClick={() => {
          props.onLeave();
          props.onDelete(props.action);
        }}
      >
        Delete
      </button>
    </>
  ),
}));

const action = createMockCustomAction;

describe("CustomActionsLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCustomActionsUiStore.setState({ selectedByProject: {}, editor: null, menu: null });
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
    fireEvent.click(screen.getByRole("button", { name: "Run “Action 2”" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Stop “Action 1”" }));
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

  it("turns the menu to an action's details and back", () => {
    listed.data = [action(1), action(2)];
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Custom actions" }));
    expect(screen.getByText("Action list")).toBeTruthy();

    act(() => menuProps.onShowDetails?.(2));
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 2, actionId: 2 });
    fireEvent.click(screen.getByText("Action 2 details"));
    expect(screen.getByText("Action list")).toBeTruthy();
  });

  it("opens on the details another surface asked for, only in its conversation", () => {
    listed.data = [action(1)];
    useCustomActionsUiStore.setState({ menu: { featureId: 3, actionId: 1 } });
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    expect(screen.queryByText("Action 1 details")).toBeNull();

    act(() => useCustomActionsUiStore.getState().openMenu(2, 1));
    expect(screen.getByText("Action 1 details")).toBeTruthy();
  });

  it("closes its menu when the conversation goes, not on a remount", async () => {
    listed.data = [action(1)];
    useCustomActionsUiStore.setState({ menu: { featureId: 2, actionId: 1 } });
    const view = render(
      <StrictMode>
        <CustomActionsLauncher featureId={2} projectId={1} />
      </StrictMode>,
    );
    await act(async () => {});
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 2, actionId: 1 });

    view.unmount();
    await act(async () => {});
    expect(useCustomActionsUiStore.getState().menu).toBeNull();
  });

  it("leaves a menu another conversation asked for open when it goes", async () => {
    listed.data = [action(1)];
    const view = render(<CustomActionsLauncher featureId={2} projectId={1} />);
    act(() => useCustomActionsUiStore.getState().openMenu(3, 1));
    view.unmount();
    await act(async () => {});
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 3, actionId: 1 });
  });

  it("keeps the delete confirmation up when the last action goes", () => {
    listed.data = [action(1)];
    useCustomActionsUiStore.setState({ menu: { featureId: 2, actionId: 1 } });
    const view = render(<CustomActionsLauncher featureId={2} projectId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useCustomActionsUiStore.getState().menu).toBeNull();

    listed.data = [];
    view.rerender(<CustomActionsLauncher featureId={2} projectId={1} />);
    expect(screen.getByText("Delete Action 1?")).toBeTruthy();
  });

  it("falls back to the list when the detailed action is gone", () => {
    listed.data = [action(1)];
    useCustomActionsUiStore.setState({ menu: { featureId: 2, actionId: 9 } });
    render(<CustomActionsLauncher featureId={2} projectId={1} />);
    expect(screen.getByText("Action list")).toBeTruthy();
  });
});
