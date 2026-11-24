import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { render, screen, waitFor, within } from "@/test-utils";
import { invokeRegisteredHotkey } from "@/test/hotkeys";
import { AgentQuestionDrawer } from "./AgentQuestionDrawer";
import { ToolPermissionPrompt } from "./ToolPermissionPrompt";
import type { AgentQuestion } from "@/types/agent-question";
import type { PendingPermission } from "@/types/agent-permission";

const mocks = vi.hoisted(() => ({ phone: true }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.phone }));
vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));

const mockedUseHotkeys = vi.mocked(useHotkeys);

function pressEscape(): void {
  const definition = mockedUseHotkeys.mock.calls
    .flatMap(([definitions]) => definitions)
    .findLast((candidate) => String(candidate.hotkey) === "Escape");
  if (!definition) throw new Error("Escape is not registered");
  invokeRegisteredHotkey(definition.callback, "Escape");
}

const question: AgentQuestion = {
  question: "Which delimiter?",
  options: [{ label: "Comma" }, { label: "Tab" }],
};

const permission: PendingPermission = {
  toolName: "Bash",
  input: { command: "ls" },
  description: "Run a shell command",
  pattern: "Bash(ls*)",
  options: [
    { decision: "deny", label: "Deny", description: "Reject", collectFeedback: false },
    { decision: "allow_once", label: "Allow once", description: "Once", collectFeedback: false },
    {
      decision: "allow_future",
      label: "Allow future requests",
      description: "Future",
      collectFeedback: false,
    },
  ],
};

function renderQuestion() {
  const handlers = { onCancel: vi.fn(), onLater: vi.fn(), onSubmit: vi.fn() };
  render(<AgentQuestionDrawer questions={[question]} open inline {...handlers} />);
  return handlers;
}

describe("question gate in the phone layout", () => {
  beforeEach(() => {
    mocks.phone = true;
    mockedUseHotkeys.mockClear();
  });

  it("offers Later instead of the close button, and Later keeps the agent running", async () => {
    const user = userEvent.setup();
    const { onCancel, onLater } = renderQuestion();

    expect(screen.queryByRole("button", { name: /Dismiss question/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Later/ }));

    expect(onLater).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("puts the question off on Escape instead of stopping the agent", () => {
    const { onCancel, onLater } = renderQuestion();

    pressEscape();

    expect(onLater).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("asks before Stop agent stops it", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderQuestion();

    await user.click(screen.getByRole("button", { name: "Stop agent" }));
    const confirm = await screen.findByRole("dialog", { name: "Stop the agent?" });
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop agent" }));
    const again = await screen.findByRole("dialog", { name: "Stop the agent?" });
    await user.click(within(again).getByRole("button", { name: "Stop agent" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("gives option rows and Next a 44px target", () => {
    renderQuestion();
    expect(screen.getByText("Comma").closest("button")).toHaveClass("phone:min-h-11");
    expect(screen.getByRole("button", { name: /Submit/ })).toHaveClass("h-11");
  });

  it("keeps the desktop close button, which stops the agent, and no Later", async () => {
    mocks.phone = false;
    const user = userEvent.setup();
    const { onCancel, onLater } = renderQuestion();

    expect(screen.queryByRole("button", { name: /^Later/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop agent" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Dismiss question/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onLater).not.toHaveBeenCalled();
  });
});

describe("permission gate in the phone layout", () => {
  beforeEach(() => {
    mocks.phone = true;
    mockedUseHotkeys.mockClear();
  });

  function renderPermission() {
    const handlers = { onCancel: vi.fn(), onLater: vi.fn(), onDecision: vi.fn() };
    render(<ToolPermissionPrompt permission={permission} {...handlers} />);
    return handlers;
  }

  it("leads with Allow once as the primary action and sets Deny apart, last", () => {
    renderPermission();
    const buttons = screen
      .getAllByRole("button")
      .filter((button) => /Allow once|Allow future|Deny/.test(button.textContent ?? ""));

    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Allow once"),
      expect.stringContaining("Allow future requests"),
      expect.stringContaining("Deny"),
    ]);
    expect(buttons[0]).toHaveClass("bg-primary", "min-h-11");
    expect(buttons[1]).toHaveClass("min-h-11");
    expect(buttons[2]).toHaveClass("border-destructive/50", "min-h-11");
    expect(buttons[2].closest("[data-permission-deny-group]")).not.toBeNull();
    expect(buttons[0].closest("[data-permission-deny-group]")).toBeNull();
  });

  it("answers with the option's own decision after the reorder", async () => {
    const user = userEvent.setup();
    const { onDecision } = renderPermission();

    await user.click(screen.getByRole("button", { name: /Allow once/ }));

    expect(onDecision).toHaveBeenCalledWith("allow_once");
  });

  it("sends the tapped option's own id once Deny is moved last", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    const options = permission.options?.map((option, index) => ({
      ...option,
      optionId: `opt-${index}`,
    }));
    render(
      <ToolPermissionPrompt permission={{ ...permission, options }} onDecision={onDecision} />,
    );

    await user.click(screen.getByRole("button", { name: /Deny/ }));
    expect(onDecision).toHaveBeenLastCalledWith("deny", undefined, "opt-0");

    await user.click(screen.getByRole("button", { name: /Allow future requests/ }));
    expect(onDecision).toHaveBeenLastCalledWith("allow_future", undefined, "opt-2");
    expect(onDecision).toHaveBeenCalledTimes(2);
  });

  it("offers Later instead of the close button; Later and Escape keep the agent waiting", async () => {
    const user = userEvent.setup();
    const { onCancel, onLater } = renderPermission();

    expect(screen.queryByRole("button", { name: /Dismiss permission/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Later/ }));
    pressEscape();

    expect(onLater).toHaveBeenCalledTimes(2);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("lays every option in one row on a short screen, Deny still set apart and mapped", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    const options = [
      ...(permission.options ?? []),
      {
        decision: "deny" as const,
        label: "Deny and stop",
        description: "Stop",
        collectFeedback: false,
      },
    ].map((option, index) => ({ ...option, optionId: `opt-${index}` }));
    render(
      <ToolPermissionPrompt permission={{ ...permission, options }} onDecision={onDecision} />,
    );

    const row = document.querySelector("[data-permission-options]");
    expect(row).toHaveClass("phone-short:flex-row");
    const denyGroup = row?.querySelector<HTMLElement>("[data-permission-deny-group]");
    expect(denyGroup).toHaveClass("phone-short:flex-row", "phone-short:border-l");
    expect(denyGroup?.style.getPropertyValue("--deny-count")).toBe("2");
    const optionButtons = within(row as HTMLElement).getAllByRole("button");
    expect(optionButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Allow once"),
      expect.stringContaining("Allow future requests"),
      expect.stringContaining("Deny"),
      expect.stringContaining("Deny and stop"),
    ]);
    for (const button of optionButtons) {
      expect(button).toHaveClass("min-h-11", "phone-short:flex-1", "phone-short:min-w-0");
      expect(button.lastElementChild).toHaveClass("phone-short:truncate");
    }

    await user.click(optionButtons[3]);
    expect(onDecision).toHaveBeenLastCalledWith("deny", undefined, "opt-3");
    await user.click(optionButtons[2]);
    expect(onDecision).toHaveBeenLastCalledWith("deny", undefined, "opt-0");
    await user.click(optionButtons[0]);
    expect(onDecision).toHaveBeenLastCalledWith("allow_once", undefined, "opt-1");
  });

  it("keeps the provider's order and one card style on desktop", () => {
    mocks.phone = false;
    renderPermission();
    const first = screen.getAllByRole("button").find((b) => b.textContent?.includes("Deny"));
    expect(first).not.toHaveClass("bg-primary");
    expect(screen.queryByRole("button", { name: /^Later/ })).not.toBeInTheDocument();
    expect(document.querySelector("[data-permission-deny-group]")).toBeNull();
  });
});
