import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import type { VirtualSkillPayload } from "@/api/generated";
import type { PromptEditorHandle } from "@/components/prompt-editor/PromptEditor";
import { focusInSkillWizard } from "./skill-wizard-focus";
import { useVirtualSkillWizard } from "./useVirtualSkillWizard";
import { VirtualSkillWizard } from "./VirtualSkillWizard";

const { mockUseListVirtualSkills, mockAgentCatalog } = vi.hoisted(() => ({
  mockUseListVirtualSkills: vi.fn(),
  mockAgentCatalog: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListVirtualSkills: (...args: unknown[]) => mockUseListVirtualSkills(...args),
}));

vi.mock("@/api/agentRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/agentRuntime")>()),
  useAgentCatalog: () => mockAgentCatalog(),
}));

const SKILLS: VirtualSkillPayload[] = [
  {
    command: "cadencr:review",
    description: "Spawn an independent reviewer session on this worktree",
    details: "Starts a separate, read-only reviewer session.",
    argument_hint: "unstaged (default) or branch",
    parameters: { agent: true, worktrees: ["same", "new", "project"] },
  },
  {
    command: "cadencr:status",
    description: "Render the live tree",
    details: "Read-only.",
    argument_hint: null,
    parameters: { agent: false, worktrees: [] },
  },
];

/** The wizard as the composer mounts it, plus what a send would deliver. */
const focusPrompt = vi.fn();
const editorRef = { current: { focus: focusPrompt } as unknown as PromptEditorHandle };

function Harness({ text }: { text: string }): ReactElement {
  const wizard = useVirtualSkillWizard(text);
  const [sent, setSent] = useState("");
  return (
    <>
      <VirtualSkillWizard state={wizard.state} editorRef={editorRef} shortcutsEnabled />
      <button type="button" onClick={() => setSent(wizard.decorate(text))}>
        send
      </button>
      <output data-testid="sent">{sent}</output>
    </>
  );
}

beforeEach(() => {
  focusPrompt.mockReset();
  mockUseListVirtualSkills.mockReturnValue({
    data: SKILLS,
    isLoading: false,
    isError: false,
  });
  mockAgentCatalog.mockReturnValue({
    data: { providers: [] },
    isLoading: false,
    isError: false,
  });
});

describe("VirtualSkillWizard", () => {
  it("shows the full description and the spawn controls of a configurable skill", () => {
    render(<Harness text="/cadencr:review branch" />);
    expect(screen.getByRole("region", { name: "Configure /cadencr:review" })).toBeInTheDocument();
    expect(screen.getByText(/Starts a separate, read-only reviewer session\./)).toBeInTheDocument();
    expect(screen.getByText("unstaged (default) or branch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /the agent picks/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Where it works: Same worktree" }),
    ).toBeInTheDocument();
  });

  it("renders nothing for a skill without parameters or a plain prompt", () => {
    const { rerender } = render(<Harness text="/cadencr:status" />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    rerender(<Harness text="review this please" />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("waits for a complete skill name: a partial one mounts nothing", () => {
    render(<Harness text="/cadencr:rev" />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it("states that the skill catalog is loading", () => {
    mockUseListVirtualSkills.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    render(<Harness text="/cadencr:review" />);
    expect(screen.getByText("Loading /cadencr:review…")).toBeInTheDocument();
  });

  it("writes the chosen worktree into the sent prompt", async () => {
    const user = userEvent.setup();
    render(<Harness text="/cadencr:review branch" />);
    expect(screen.queryByTitle(/Added after the command/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Where it works: Same worktree" }));
    await user.click(await screen.findByRole("menuitem", { name: /New worktree/ }));
    expect(
      screen.getByRole("button", { name: "Where it works: New worktree" }),
    ).toBeInTheDocument();
    // The wizard previews exactly what the send adds.
    expect(screen.getByTitle("Added after the command: --worktree=new")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "send" }));
    expect(screen.getByTestId("sent")).toHaveTextContent("/cadencr:review --worktree=new branch");
  });

  it("says who owns the keys and hands them back to the prompt on Esc", async () => {
    const user = userEvent.setup();
    render(<Harness text="/cadencr:review" />);
    expect(screen.getByText("Configure")).toBeInTheDocument();
    expect(focusInSkillWizard()).toBe(false);

    screen.getByRole("button", { name: "Where it works: Same worktree" }).focus();
    expect(await screen.findByText("Shortcuts set the spawned session")).toBeInTheDocument();
    // The session's own composer shortcuts stand down while the wizard has focus.
    expect(focusInSkillWizard()).toBe(true);

    await user.keyboard("{Escape}");
    expect(focusPrompt).toHaveBeenCalledOnce();
  });
});
