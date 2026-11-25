import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import type { Feature, Project, ScheduleTarget } from "@/api/generated";
import { uiI18n } from "@/lib/i18n/ui";
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

  afterEach(async () => {
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    uiI18n.removeResourceBundle("fr", "ui");
  });

  it("retranslates an open picker while keeping its search, focus and raw titles", async () => {
    const { user } = render(<Harness initial={{ kind: "conversation", project_id: 1 }} />);
    await user.click(screen.getByRole("combobox", { name: "Conversation" }));
    const search = await screen.findByRole("combobox", { name: "Search conversation" });
    await user.type(search, "Ship");
    expect(await screen.findByRole("option", { name: "Ship schedules" })).toBeVisible();

    uiI18n.addResourceBundle("fr", "ui", {
      schedules: {
        editor: { conversation: "Discussion" },
        picker: {
          searchConversation: "Rechercher une discussion",
          searchConversationsPlaceholder: "Rechercher des discussions…",
        },
      },
    });
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });

    expect(screen.getByRole("combobox", { name: "Rechercher une discussion" })).toBe(search);
    expect(search).toHaveFocus();
    expect(search).toHaveValue("Ship");
    expect(search).toHaveAttribute("placeholder", "Rechercher des discussions…");
    await user.click(screen.getByRole("option", { name: "Ship schedules" }));
    expect(screen.getByRole("combobox", { name: "Discussion" })).toHaveTextContent(
      "Ship schedules",
    );
    expect(currentTarget().feature_id).toBe(11);
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
