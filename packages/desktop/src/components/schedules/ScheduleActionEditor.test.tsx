import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test-utils";
import type { Project, SaveScheduleRequest } from "@/api/generated";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { switchScheduleKind } from "./ScheduleActionEditor";

const { mockUseListFeatures, mockUseListCustomActions } = vi.hoisted(() => ({
  mockUseListFeatures: vi.fn(),
  mockUseListCustomActions: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListFeatures: (...args: unknown[]) => mockUseListFeatures(...args),
  useListCustomActions: (...args: unknown[]) => mockUseListCustomActions(...args),
}));

vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => null }));

vi.mock("./ScheduleComposer", () => ({
  ScheduleComposer: () => <div>prompt composer</div>,
}));

const PROJECTS: Project[] = [{ id: 1, name: "cadencr", path: "/tmp/cadencr" } as Project];

type SaveFn = (body: SaveScheduleRequest, id?: number) => Promise<unknown>;

describe("scheduling a custom action", () => {
  beforeEach(() => {
    mockUseListFeatures.mockReturnValue({
      data: [{ id: 7, title: "Fix login" }],
      isLoading: false,
      isError: false,
    });
    mockUseListCustomActions.mockReturnValue({
      data: [{ id: 3, name: "Run tests", icon_data: null }],
      isLoading: false,
      isError: false,
    });
  });

  it("opens prefilled from an action link and saves an action target", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValue(undefined);
    render(
      <ScheduleEditorDialog
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        onSave={onSave}
        initialAction={{ projectId: 1, featureId: 7, actionId: 3 }}
      />,
    );

    // No prompt to write and no command to gate on: an action is its own check.
    expect(screen.queryByText("prompt composer")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Only send when a command fails/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Run a custom action/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      prompt: "",
      condition: null,
      target: { kind: "custom_action", feature_id: 7, action_id: 3 },
    });
  });

  it("needs a conversation and an action before it can save", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValue(undefined);
    const { user } = render(
      <ScheduleEditorDialog open onOpenChange={vi.fn()} projects={PROJECTS} onSave={onSave} />,
    );

    await user.click(screen.getByRole("button", { name: /Run a custom action/ }));

    expect(screen.queryByText("prompt composer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create schedule/ })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("only schedules messages from a conversation's own composer", () => {
    render(
      <ScheduleEditorDialog
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        onSave={vi.fn<SaveFn>()}
        lockedConversation={{ featureId: 7, projectId: 1 }}
      />,
    );

    expect(screen.queryByRole("button", { name: /Run a custom action/ })).toBeNull();
    expect(screen.getByText("prompt composer")).toBeInTheDocument();
  });
});

describe("switchScheduleKind", () => {
  it("keeps the picked conversation across the switch", () => {
    const action = switchScheduleKind(
      { kind: "conversation", project_id: 1, feature_id: 7 },
      true,
      PROJECTS,
    );
    expect(action).toEqual({ kind: "custom_action", project_id: 1, feature_id: 7 });
    expect(switchScheduleKind({ ...action, action_id: 3 }, false, PROJECTS)).toEqual({
      kind: "conversation",
      project_id: 1,
      feature_id: 7,
    });
  });

  it("starts without a conversation when leaving a new-conversation target", () => {
    expect(switchScheduleKind({ kind: "new_conversation", project_id: 1 }, true, PROJECTS)).toEqual(
      { kind: "custom_action", project_id: 1, feature_id: undefined },
    );
  });
});
