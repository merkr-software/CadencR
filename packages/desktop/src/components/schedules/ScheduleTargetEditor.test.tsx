import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { Feature, Project, ScheduleTarget } from "@/api/generated";
import { ScheduleTargetEditor } from "./ScheduleTargetEditor";

const { mockUseListFeatures } = vi.hoisted(() => ({
  mockUseListFeatures: vi.fn(),
}));

// The badge fetches project settings of its own; the picker is what's under test.
vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: ({ projectId }: { projectId: number }) => (
    <span data-testid={`project-badge-${projectId}`} />
  ),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListFeatures: (...args: unknown[]) => mockUseListFeatures(...args),
}));

const PROJECTS = [
  { id: 1, name: "Cadencr", path: "/tmp/cadencr" },
  { id: 2, name: "Landing", path: "/tmp/landing" },
] as unknown as Project[];

function feature(id: number, title: string, projectId = 1): Feature {
  return { id, title, project_id: projectId } as unknown as Feature;
}

function listResult(data: Feature[], overrides: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, ...overrides };
}

/** Mirrors the dialog: the editor is controlled, so the test owns the target. */
function Harness({ initial }: { initial: ScheduleTarget }): ReactElement {
  const [target, setTarget] = useState<ScheduleTarget>(initial);
  return (
    <>
      <ScheduleTargetEditor value={target} onChange={setTarget} projects={PROJECTS} />
      <output data-testid="target">{JSON.stringify(target)}</output>
    </>
  );
}

function currentTarget(): ScheduleTarget {
  return JSON.parse(screen.getByTestId("target").textContent ?? "{}") as ScheduleTarget;
}

describe("ScheduleTargetEditor", () => {
  beforeEach(() => {
    mockUseListFeatures.mockReset();
    mockUseListFeatures.mockReturnValue(
      listResult([feature(10, "Fix the parser"), feature(11, "Ship schedules")]),
    );
  });

  it("lets you pick a conversation after switching to an existing conversation", async () => {
    const { user } = render(
      <Harness initial={{ kind: "new_conversation", project_id: 1, worktree_mode: "skip" }} />,
    );

    await user.click(screen.getByRole("button", { name: /Existing conversation/ }));
    await user.click(screen.getByRole("combobox", { name: "Conversation" }));
    await user.click(await screen.findByText("Ship schedules"));

    const target = currentTarget();
    expect(target.kind).toBe("conversation");
    expect(target.feature_id).toBe(11);
  });

  // The project select is what scopes the list, so it has to stay visible for
  // conversation targets — its absence was the original bug.
  it("keeps the project select for conversation targets and clears a stale pick", async () => {
    const { user } = render(<Harness initial={{ kind: "conversation", project_id: 1 }} />);

    await user.click(screen.getByRole("combobox", { name: "Conversation" }));
    await user.click(await screen.findByText("Fix the parser"));
    expect(currentTarget().feature_id).toBe(10);

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "Landing" }));

    const target = currentTarget();
    expect(target.project_id).toBe(2);
    expect(target.feature_id).toBeUndefined();
  });

  it("shows the stored title until the conversation list resolves", () => {
    mockUseListFeatures.mockReturnValue(listResult([], { isLoading: true }));
    render(
      <>
        <ScheduleTargetEditor
          value={{ kind: "conversation", project_id: 1, feature_id: 10 }}
          onChange={vi.fn()}
          projects={PROJECTS}
          targetedConversationTitle="Fix the parser"
        />
      </>,
    );

    expect(screen.getByText("Loading conversations…")).toBeInTheDocument();
  });

  it("explains an empty project instead of offering an empty picker", () => {
    mockUseListFeatures.mockReturnValue(listResult([]));
    render(
      <ScheduleTargetEditor
        value={{ kind: "conversation", project_id: 1 }}
        onChange={vi.fn()}
        projects={PROJECTS}
      />,
    );

    expect(screen.getByText("This project has no conversations yet.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Conversation" })).not.toBeInTheDocument();
  });

  it("surfaces a failed conversation load", () => {
    mockUseListFeatures.mockReturnValue(listResult([], { isError: true }));
    render(
      <ScheduleTargetEditor
        value={{ kind: "conversation", project_id: 1 }}
        onChange={vi.fn()}
        projects={PROJECTS}
      />,
    );

    expect(screen.getByText(/Could not load/)).toBeInTheDocument();
  });
});
