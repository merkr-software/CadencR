import { forwardRef, useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { ScheduleTarget } from "@/api/generated";
import type { PromptEditorHandle } from "@/components/prompt-editor/PromptEditor";
import { ScheduleComposer } from "./ScheduleComposer";

const {
  mockAgentCatalog,
  mockUseGetBranch,
  mockUseListFeatures,
  mockUseListBranches,
  mockUseGetPromptCommands,
} = vi.hoisted(() => ({
  mockAgentCatalog: vi.fn(),
  mockUseGetBranch: vi.fn(),
  mockUseListFeatures: vi.fn(),
  mockUseListBranches: vi.fn(),
  mockUseGetPromptCommands: vi.fn(),
}));

// Records what the composer hands the editor while still rendering the real
// one — driving Lexical's own menus is PromptEditor's test, not this one.
type PromptEditorProps = Record<string, unknown>;
let lastEditorProps: PromptEditorProps = {};
vi.mock("@/components/prompt-editor/PromptEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/prompt-editor/PromptEditor")>();
  return {
    ...actual,
    PromptEditor: forwardRef<PromptEditorHandle, PromptEditorProps>(
      function RecordingPromptEditor(props, ref) {
        lastEditorProps = props;
        const Actual = actual.PromptEditor as unknown as React.ComponentType<PromptEditorProps>;
        return <Actual ref={ref} {...props} />;
      },
    ),
  };
});

vi.mock("@/hooks/useFavoriteModels", () => ({
  useFavoriteModels: () => ({ favorites: new Set<string>(), toggleFavorite: vi.fn() }),
}));

// The project's own default resolution has its own settings cascade; here we
// only care that the chip shows what it resolves to.
vi.mock("@/hooks/useProjectRuntimeSelection", () => ({
  useProjectRuntimeSelection: () => ({ providerId: "claude_code", modelId: "sonnet" }),
}));

vi.mock("@/api/agentRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/agentRuntime")>()),
  useAgentCatalog: () => mockAgentCatalog(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetBranch: (...args: unknown[]) => mockUseGetBranch(...args),
  useListFeatures: (...args: unknown[]) => mockUseListFeatures(...args),
  useListBranches: (...args: unknown[]) => mockUseListBranches(...args),
  useGetPromptCommands: (...args: unknown[]) => mockUseGetPromptCommands(...args),
}));

const CATALOG = {
  default_provider: "claude_code",
  providers: [
    {
      id: "claude_code",
      label: "Claude Code",
      status: "available",
      default_model: "sonnet",
      models: [
        { id: "sonnet", label: "Sonnet", supports_effort: false },
        { id: "haiku", label: "Haiku", supports_effort: false },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      status: "available",
      default_model: "gpt-5",
      models: [{ id: "gpt-5", label: "GPT-5", supports_effort: false }],
    },
  ],
};

/** Mirrors the dialog: the composer is controlled by the form state. */
function Harness({ initial }: { initial: ScheduleTarget }): ReactElement {
  const [target, setTarget] = useState<ScheduleTarget>(initial);
  return (
    <>
      <ScheduleComposer
        initialPrompt="Review yesterday's diffs"
        onPromptChange={vi.fn()}
        target={target}
        onTargetChange={setTarget}
      />
      <output data-testid="target">{JSON.stringify(target)}</output>
    </>
  );
}

function currentTarget(): ScheduleTarget {
  return JSON.parse(screen.getByTestId("target").textContent ?? "{}") as ScheduleTarget;
}

describe("ScheduleComposer", () => {
  beforeEach(() => {
    mockAgentCatalog.mockReturnValue({ data: CATALOG });
    mockUseGetBranch.mockReturnValue({ data: { branch: "main" } });
    mockUseGetPromptCommands.mockReturnValue({
      data: {
        commands: [{ name: "finish-job", description: "Wrap up safely", kind: "skill" }],
        prompt_command_policy: {
          slash_command_placement: "prompt_start",
          skill_reference_trigger: "slash",
          user_shell: true,
        },
      },
      isLoading: false,
    });
    mockUseListBranches.mockReturnValue({ data: [], isLoading: false, isError: false });
    mockUseListFeatures.mockReturnValue({
      data: [
        {
          id: 7,
          title: "Ship schedules",
          project_id: 1,
          runtime_provider: "claude_code",
          model_session: "haiku",
          permission_mode: "plan",
        },
      ],
      isLoading: false,
      isError: false,
    });
  });

  it("writes the prompt into the real editor rather than a textarea", () => {
    render(<Harness initial={{ kind: "new_conversation", project_id: 1 }} />);

    expect(screen.getByText("Review yesterday's diffs")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /prompt/i })).not.toBeInTheDocument();
  });

  it("shows the model the project would start with, and pins the one you pick", async () => {
    const { user } = render(<Harness initial={{ kind: "new_conversation", project_id: 1 }} />);

    // The resolved default, not the words "project default".
    expect(screen.getByText("Sonnet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Sonnet/ }));
    await user.click(await screen.findByRole("option", { name: /Haiku/i }));

    const target = currentTarget();
    expect(target.provider).toBe("claude_code");
    expect(target.model).toBe("haiku");
  });

  it("stores the working copy the run should use", async () => {
    const { user } = render(<Harness initial={{ kind: "new_conversation", project_id: 1 }} />);

    await user.click(screen.getByRole("button", { name: "Branch / worktree behavior" }));
    await user.click(await screen.findByRole("button", { name: /From branch with worktree/ }));

    expect(currentTarget()).toMatchObject({ worktree_mode: "new" });
  });

  // A scheduled run never checks a branch out, so naming one means "run it
  // there" — which for a schedule is a worktree on that branch.
  it("turns a branch pick into a worktree rather than a silent checkout", async () => {
    mockUseListBranches.mockReturnValue({
      data: [
        { name: "main", is_local: true },
        { name: "feature/x", is_local: true },
      ],
      isLoading: false,
      isError: false,
    });
    const { user } = render(<Harness initial={{ kind: "new_conversation", project_id: 1 }} />);

    await user.click(screen.getByRole("button", { name: /main/ }));
    await user.click(await screen.findByText("feature/x"));

    expect(currentTarget()).toMatchObject({
      worktree_mode: "reuse",
      reuse_branch: "feature/x",
    });
  });

  it("lets an existing conversation's schedule pick a model but not an agent", async () => {
    const { user } = render(
      <Harness initial={{ kind: "conversation", project_id: 1, feature_id: 7 }} />,
    );

    // The conversation's own model, and no working-copy chip: the run uses the
    // conversation's worktree whatever the schedule says.
    expect(screen.getByText("Haiku")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Branch / worktree behavior" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Haiku/ }));
    // Only the conversation's own agent is offered.
    expect(screen.queryByRole("option", { name: /GPT-5/i })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("option", { name: /Sonnet/i }));
    const target = currentTarget();
    expect(target.model).toBe("sonnet");
    // The provider is the conversation's; the backend drops it either way.
    expect(target.provider).toBeUndefined();
  });

  it("cycles the collaboration mode and pins what it lands on", async () => {
    const { user } = render(<Harness initial={{ kind: "new_conversation", project_id: 1 }} />);

    // Unpinned shows what a new conversation on this agent would start in.
    const chip = screen.getByRole("button", { name: /Permission mode: Auto-Accept Edits/ });
    await user.click(chip);

    expect(currentTarget().permission_mode).toBe("plan");
    expect(screen.getByRole("button", { name: /Permission mode: Plan/ })).toBeInTheDocument();
  });

  // An unpinned schedule inherits the conversation's mode, so the chip has to
  // read it from the conversation rather than assume the provider default.
  it("shows the mode the targeted conversation is already in", () => {
    render(<Harness initial={{ kind: "conversation", project_id: 1, feature_id: 7 }} />);

    expect(screen.getByRole("button", { name: /Permission mode: Plan/ })).toBeInTheDocument();
    expect(currentTarget().permission_mode).toBeUndefined();
  });

  it("gives the editor the provider's own commands and skills", () => {
    render(<Harness initial={{ kind: "new_conversation", project_id: 1 }} />);

    expect(lastEditorProps.slashCommands).toEqual([
      { name: "finish-job", description: "Wrap up safely", kind: "skill" },
    ]);
    // `!` runs a shell command on a live session's own channel. A scheduled
    // prompt has no such channel, so the trigger stays off however the provider
    // advertises itself.
    expect(lastEditorProps.promptCommandPolicy).toMatchObject({
      skillReferenceTrigger: "slash",
      userShell: false,
    });
  });
});
