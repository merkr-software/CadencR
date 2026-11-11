import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import type { FeatureGateDecision, FeaturePendingGateResponse } from "@/api/generated";
import { PendingGateBody } from "./PendingGateBody";

const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/hooks/useFeaturePendingGate", () => ({ useFeaturePendingGate: () => hook.value }));

const respond = vi.fn<(decision: FeatureGateDecision) => void>();
const onOpenConversation = vi.fn();

function mockHook(partial: Record<string, unknown>): void {
  hook.value = {
    gate: undefined,
    isLoading: false,
    isError: false,
    errorMessage: null,
    isSubmitting: false,
    respond,
    ...partial,
  };
}

function permissionGate(
  overrides: Record<string, unknown> = {},
  lastText: string | null = null,
): FeaturePendingGateResponse {
  return {
    session_id: 1,
    request_id: "req-1",
    kind: "permission",
    last_assistant_text: lastText,
    payload: {
      tool_name: "Bash",
      tool_input: { command: "sh check.sh", description: "Run check.sh script" },
      description: "This command requires approval",
      preview: "sh check.sh",
      options: [
        { decision: "allow_once", label: "Allow once", description: "Approve this tool call only" },
        { decision: "allow_future", label: "Allow future requests", description: "Apply it" },
        { decision: "deny", label: "Deny", description: "Reject", collect_feedback: true },
      ],
      ...overrides,
    },
  };
}

function questionGate(questions: unknown[]): FeaturePendingGateResponse {
  return {
    session_id: 1,
    request_id: "req-q",
    kind: "question",
    payload: { tool_name: "AskUserQuestion", tool_input: { questions } },
  };
}

function renderBody(props: { autoFocus?: boolean; touch?: boolean } = {}) {
  return render(
    <PendingGateBody
      featureId={1}
      autoFocus={props.autoFocus ?? false}
      touch={props.touch}
      onOpenConversation={onOpenConversation}
    />,
  );
}

beforeEach(() => {
  respond.mockClear();
  onOpenConversation.mockClear();
});

describe("PendingGateBody states", () => {
  it("shows a skeleton while loading", () => {
    mockHook({ isLoading: true });
    renderBody();
    expect(screen.getByRole("status", { name: "Loading request" })).toBeInTheDocument();
  });

  it("shows the error and a way to the conversation", async () => {
    mockHook({ isError: true, errorMessage: "Boom" });
    renderBody();
    expect(screen.getByText("Boom")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
  });

  it("renders a plan as one line and a button", () => {
    mockHook({ gate: { ...permissionGate(), kind: "plan" } });
    renderBody();
    expect(screen.getByText("Plan ready for review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open conversation" })).toBeInTheDocument();
  });
});

describe("permission body", () => {
  it("shows the justification, the command and the provider's actions in order", () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    expect(screen.getByText("Run check.sh script")).toBeInTheDocument();
    expect(screen.getByText("sh check.sh")).toBeInTheDocument();
    const labels = screen
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("data-gate-action"))
      .map((button) => button.textContent);
    expect(labels).toEqual(["Allow once1", "Allow future requests2", "Deny3"]);
    // Descriptions are tooltips, not body text.
    expect(screen.queryByText("Approve this tool call only")).toBeNull();
    expect(screen.getByRole("button", { name: /Allow once/ })).toHaveAttribute(
      "title",
      "Approve this tool call only",
    );
  });

  it("falls back to the last assistant text, then to the payload description", () => {
    mockHook({ gate: permissionGate({ tool_input: { command: "ls" }, preview: "ls" }, "Listing") });
    const first = renderBody();
    expect(screen.getByText("Listing")).toBeInTheDocument();
    first.unmount();
    mockHook({ gate: permissionGate({ tool_input: { command: "ls" }, preview: "ls" }) });
    renderBody();
    expect(screen.getByText("This command requires approval")).toBeInTheDocument();
  });

  it("only offers what the payload provides", () => {
    mockHook({
      gate: permissionGate({ options: [{ decision: "allow_once", label: "Allow once" }] }),
    });
    renderBody();
    expect(screen.queryByRole("button", { name: /Deny/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeInTheDocument();
  });

  it("sends allow_once and allow_always straight away", async () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(respond).toHaveBeenLastCalledWith({ type: "permission", action: "allow_once" });
    await userEvent.click(screen.getByRole("button", { name: /Allow future requests/ }));
    expect(respond).toHaveBeenLastCalledWith({ type: "permission", action: "allow_always" });
  });

  it("deny with feedback asks for a message first and sends it", async () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    expect(respond).not.toHaveBeenCalled();
    const field = screen.getByRole("textbox", { name: "Tell the agent what to do instead" });
    await userEvent.type(field, "use make instead");
    await userEvent.keyboard("{Enter}");
    expect(respond).toHaveBeenCalledWith({
      type: "permission",
      action: "deny",
      message: "use make instead",
    });
  });

  it("deny without a message sends none, and Shift+Enter writes a new line", async () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Tell the agent what to do instead" }),
      "a{Shift>}{Enter}{/Shift}b",
    );
    expect(screen.getByRole("textbox")).toHaveValue("a\nb");
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(respond).toHaveBeenCalledWith({ type: "permission", action: "deny" });
  });

  it("Escape in the field cancels it without reaching the popover", async () => {
    mockHook({ gate: permissionGate() });
    const outer = vi.fn();
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={outer}>
        <PendingGateBody featureId={1} autoFocus={false} onOpenConversation={onOpenConversation} />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("denies at once when the provider takes no feedback", async () => {
    mockHook({
      gate: permissionGate({ options: [{ decision: "deny", label: "Deny" }] }),
    });
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    expect(respond).toHaveBeenCalledWith({ type: "permission", action: "deny" });
  });

  it("digits pick the n-th action; Enter takes the first allowing one", () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    const root = screen.getByRole("button", { name: /Allow once/ });
    fireEvent.keyDown(root, { key: "2", code: "Digit2" });
    expect(respond).toHaveBeenLastCalledWith({ type: "permission", action: "allow_always" });
    fireEvent.keyDown(root.parentElement!, { key: "Enter" });
    expect(respond).toHaveBeenLastCalledWith({ type: "permission", action: "allow_once" });
    // AZERTY: the unshifted digit key reports `&`.
    fireEvent.keyDown(root, { key: "&", code: "Digit1" });
    expect(respond).toHaveBeenLastCalledWith({ type: "permission", action: "allow_once" });
  });

  it("digit 3 opens the deny field instead of denying", () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    fireEvent.keyDown(screen.getByRole("button", { name: /Allow once/ }), {
      key: "3",
      code: "Digit3",
    });
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("disables the actions and spins on the clicked one while submitting", async () => {
    mockHook({ gate: permissionGate() });
    const view = renderBody();
    await userEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    mockHook({ gate: permissionGate(), isSubmitting: true });
    view.rerender(
      <PendingGateBody featureId={1} autoFocus={false} onOpenConversation={onOpenConversation} />,
    );
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getAllByLabelText("Sending")).toHaveLength(1);
  });

  it("focuses the first action only when autoFocus is set", () => {
    mockHook({ gate: permissionGate() });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const first = renderBody({ autoFocus: false });
    expect(focus).not.toHaveBeenCalled();
    first.unmount();
    renderBody({ autoFocus: true });
    expect(screen.getByRole("button", { name: /Allow once/ })).toHaveFocus();
    focus.mockRestore();
  });

  it("uses touch-sized buttons", () => {
    mockHook({ gate: permissionGate() });
    renderBody({ touch: true });
    expect(screen.getByRole("button", { name: /Allow once/ })).toHaveClass("h-11");
  });

  it("shows a long justification clamped, with a toggle", async () => {
    mockHook({ gate: permissionGate({ tool_input: { description: "x ".repeat(300) } }) });
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(100);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });

  it("has no toggle for a short justification", () => {
    mockHook({ gate: permissionGate() });
    renderBody();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("question body", () => {
  const single = questionGate([
    {
      question: "Which unit?",
      options: [{ label: "4 px" }, { label: "8 px", description: "big" }],
    },
  ]);

  it("answers a single-select question on click", async () => {
    mockHook({ gate: single });
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: /8 px/ }));
    expect(respond).toHaveBeenCalledWith({ type: "question", answers: [["8 px"]] });
  });

  it("digits answer a single-select; the digit after the last option opens Other", async () => {
    mockHook({ gate: single });
    renderBody();
    const option = screen.getByRole("button", { name: /4 px/ });
    fireEvent.keyDown(option, { key: "1", code: "Digit1" });
    expect(respond).toHaveBeenLastCalledWith({ type: "question", answers: [["4 px"]] });
    fireEvent.keyDown(option, { key: "3", code: "Digit3" });
    const input = await screen.findByRole("textbox", { name: "Your answer" });
    await userEvent.type(input, "6 px{Enter}");
    expect(respond).toHaveBeenLastCalledWith({ type: "question", answers: [["6 px"]] });
  });

  it("collects a multi-select with a Submit button", async () => {
    mockHook({
      gate: questionGate([
        {
          question: "Pick",
          multiSelect: true,
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ]),
    });
    renderBody();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^1?A/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: /B/ }), { key: "3", code: "Digit3" });
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(respond).toHaveBeenCalledWith({ type: "question", answers: [["A", "C"]] });
  });

  it("steps through several questions and submits one answer list per question", async () => {
    mockHook({
      gate: questionGate([
        { question: "First?", options: [{ label: "Yes" }, { label: "No" }] },
        { question: "Second?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
        { question: "Third?" },
      ]),
    });
    renderBody();
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(screen.getByText("Second?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(screen.getByText("First?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next question" }));
    await userEvent.click(screen.getByRole("button", { name: /^X|X$/ }));
    await userEvent.click(screen.getByRole("button", { name: /Y/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "free text");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(respond).toHaveBeenCalledWith({
      type: "question",
      answers: [["Yes"], ["X", "Y"], ["free text"]],
    });
  });

  it("encodes Other next to selected options of a multi-select", async () => {
    mockHook({
      gate: questionGate([
        { question: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
      ]),
    });
    renderBody();
    await userEvent.click(screen.getByRole("button", { name: /A/ }));
    await userEvent.click(screen.getByRole("button", { name: /Other/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "mine");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(respond).toHaveBeenCalledWith({ type: "question", answers: [["A", "mine"]] });
  });

  it("focuses the first option only when autoFocus is set", () => {
    mockHook({ gate: single });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const first = renderBody({ autoFocus: false });
    expect(focus).not.toHaveBeenCalled();
    first.unmount();
    renderBody({ autoFocus: true });
    expect(screen.getByRole("button", { name: /4 px/ })).toHaveFocus();
    focus.mockRestore();
  });

  it("disables the form and shows progress while submitting", () => {
    mockHook({ gate: single, isSubmitting: true });
    renderBody();
    expect(screen.getByRole("button", { name: /4 px/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  });
});
