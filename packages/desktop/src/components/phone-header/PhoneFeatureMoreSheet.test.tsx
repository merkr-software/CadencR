import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import type { GitActionController } from "@/components/git-actions/useGitActionController";
import type { GitActionState, GitActivities } from "@/components/git-actions/useGitAction";
import type { WorktreeSetupHeaderProps } from "@/components/WorktreeSetupHeader";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { createMockCustomAction } from "@/test-fixtures";

import { PhoneFeatureMoreSheet } from "./PhoneFeatureMoreSheet";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    isPending: false,
    isSuccess: true,
    isError: false,
    error: null as unknown,
  },
  activateAction: vi.fn(),
}));

vi.mock("@/hooks/useFeatureCustomActions", () => ({
  useFeatureCustomActions: () => mocks.query,
  useIsActionStarting: () => false,
}));
vi.mock("@/components/custom-actions/useCustomActionsLauncher", () => ({
  activateAction: mocks.activateAction,
}));
vi.mock("@/components/branch-chip/BranchChip", () => ({
  BranchChip: () => <button type="button">Branch chip</button>,
}));
vi.mock("@/components/git-actions/useGitUpdateRecoveryActions", () => ({
  useGitUpdateRecoveryActions: () => ({
    pending: false,
    pendingAction: null,
    error: null,
    continueUpdate: vi.fn(),
    abortUpdate: vi.fn(),
  }),
}));

const STATE: GitActionState = {
  primary: "commit",
  label: "Commit",
  disabled: {
    commit: null,
    stash: null,
    update: "Commit or stash your changes first",
    push: null,
    pr: "Push your commits first",
    merge: "Nothing to merge",
  },
  compareLabel: "Open pull request",
  updatePending: false,
  recovery: null,
};
const IDLE: GitActivities = { commit: null, push: null };

function worktree(onToggle: () => void): WorktreeSetupHeaderProps {
  return { branch: "feature/x", branchExists: true, status: "ready", isOpen: false, onToggle };
}

function Harness({
  runAction,
  activities = IDLE,
  worktree = null,
  featureLabel = null,
}: {
  runAction: (action: string) => boolean | undefined;
  activities?: GitActivities;
  worktree?: WorktreeSetupHeaderProps | null;
  featureLabel?: string | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const git: GitActionController = {
    snapshot: undefined,
    state: STATE,
    activities,
    statusRetry: { pending: false, run: () => {} },
    pickerOpen: open,
    setPickerOpen: setOpen,
    runAction: (action) => {
      setOpen(false);
      return runAction(action) ?? true;
    },
    dialogs: {} as GitActionController["dialogs"],
  };
  return (
    <PhoneFeatureMoreSheet
      featureId={4}
      projectId={1}
      git={git}
      worktree={worktree}
      featureLabel={featureLabel}
      showCustomActions
    />
  );
}

function openSheet(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /^Conversation actions/ }));
  return screen.getByRole("dialog", { name: "Conversation actions" });
}

describe("PhoneFeatureMoreSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query = { data: [], isPending: false, isSuccess: true, isError: false, error: null };
    useCustomActionsUiStore.setState({ menu: null });
  });

  it("lists the Git actions with their reasons and runs the one picked", () => {
    const runAction = vi.fn();
    render(<Harness runAction={runAction} />);
    const sheet = openSheet();

    expect(within(sheet).getByRole("button", { name: /^Update/ })).toBeDisabled();
    expect(within(sheet).getByText("Commit or stash your changes first")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Commit" }));
    expect(runAction).toHaveBeenCalledWith("commit");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hands focus to the dialog a Git action opens, and back to … when none opens", async () => {
    // The sheet's focus scope restores focus a task after it unmounts.
    const settle = (): Promise<void> => act(() => new Promise<void>((done) => setTimeout(done, 0)));
    const runAction = vi.fn(() => true);
    render(<Harness runAction={runAction} />);
    const trigger = screen.getByRole("button", { name: /^Conversation actions/ });
    fireEvent.click(within(openSheet()).getByRole("button", { name: "Commit" }));
    await settle();
    expect(trigger).not.toHaveFocus();

    // A blocked stash only toasts: focus must not be left on the page body.
    runAction.mockReturnValue(false);
    fireEvent.click(within(openSheet()).getByRole("button", { name: "Stash changes" }));
    await settle();
    expect(runAction).toHaveBeenLastCalledWith("stash");
    expect(trigger).toHaveFocus();
  });

  it("shows the conversation's label", () => {
    render(<Harness runAction={vi.fn()} featureLabel="Review" />);
    expect(within(openSheet()).getByText("Review")).toBeInTheDocument();
  });

  it("shows the branch with a copy button and opens the worktree's setup details", () => {
    const onToggle = vi.fn();
    render(<Harness runAction={vi.fn()} worktree={worktree(onToggle)} />);
    const sheet = openSheet();

    expect(within(sheet).getByRole("button", { name: "Branch chip" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Copy branch name" })).toBeInTheDocument();
    expect(within(sheet).getByText("ready")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: /Worktree/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("runs a custom action and opens another's details in the custom actions sheet", () => {
    const actions = [createMockCustomAction(7), createMockCustomAction(8)];
    mocks.query.data = actions;
    render(<Harness runAction={vi.fn()} />);
    let sheet = openSheet();

    fireEvent.click(within(sheet).getByRole("button", { name: "Run “Action 7”" }));
    expect(mocks.activateAction).toHaveBeenCalledWith(actions[0], 4, 1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    sheet = openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Details of “Action 8”" }));
    expect(useCustomActionsUiStore.getState().menu).toEqual({ featureId: 4, actionId: 8 });
  });

  it("shows a loading row while the custom actions load, and their error if they fail", () => {
    mocks.query = {
      data: undefined,
      isPending: true,
      isSuccess: false,
      isError: false,
      error: null,
    };
    const view = render(<Harness runAction={vi.fn()} />);
    expect(within(openSheet()).getByText("Loading actions…")).toBeInTheDocument();
    view.unmount();

    mocks.query = {
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new Error("boom"),
    };
    render(<Harness runAction={vi.fn()} />);
    expect(within(openSheet()).getByRole("alert")).toHaveTextContent("boom");
  });

  it("flags a running Git action on the trigger", () => {
    render(<Harness runAction={vi.fn()} activities={{ commit: "running", push: null }} />);
    expect(
      screen.getByRole("button", { name: "Conversation actions, something is running" }),
    ).toBeInTheDocument();
  });
});
