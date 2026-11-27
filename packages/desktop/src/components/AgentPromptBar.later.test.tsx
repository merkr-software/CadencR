// @vitest-environment jsdom
// Focus assertions require jsdom's focus behavior.
import {
  createRef,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type ForwardedRef,
} from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import type { PendingPermission } from "@/types/agent-permission";
import type { AgentQuestion } from "@/types/agent-question";
import { AgentPromptBar, type AgentPromptBarHandle } from "./AgentPromptBar";

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/hooks/usePromptDraft", () => ({
  usePromptDraft: () => ({ saveDraft: vi.fn() }),
}));
vi.mock("@/hooks/usePromptHistory", () => ({
  usePromptHistory: () => ({ addEntry: vi.fn(), resetNavigation: vi.fn() }),
}));
vi.mock("@/hooks/useImageAttachments", () => ({
  useImageAttachments: () => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    restoreAttachments: vi.fn(),
    dragHandlers: {},
    isDragging: false,
  }),
}));

// Lexical focuses through the DOM selection, which never moves focus in jsdom:
// a plain textarea makes the composer's focus restore observable.
vi.mock("./prompt-editor/PromptEditor", () => ({
  PromptEditor: forwardRef(function MockPromptEditor(
    { onChange }: { onChange?: (text: string) => void },
    ref: ForwardedRef<object>,
  ) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const replace = (text: string): void => {
      setValue(text);
      onChange?.(text);
    };
    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      blur: () => textareaRef.current?.blur(),
      clear: () => replace(""),
      setText: replace,
      getText: () => value,
      clearShellCommandMode: () => undefined,
    }));
    return (
      <textarea ref={textareaRef} value={value} onChange={(event) => replace(event.target.value)} />
    );
  }),
}));

// No request id: put off under the fallback key `toolName:pattern`.
const permission: PendingPermission = {
  toolName: "Bash",
  input: { command: "ls" },
  description: "Run a shell command",
  pattern: "Bash(ls*)",
};

const questions: AgentQuestion[] = [
  { question: "Which delimiter?", options: [{ label: "Comma" }, { label: "Tab" }] },
];

type BarProps = Partial<ComponentProps<typeof AgentPromptBar>>;

function renderBar(props: BarProps) {
  const ref = createRef<AgentPromptBarHandle>();
  const handlers = {
    onSend: vi.fn(),
    onPermissionDecision: vi.fn(),
    onQuestionResponse: vi.fn(),
    onGateClose: vi.fn(),
  };
  const ui = (next: BarProps) => (
    <AgentPromptBar ref={ref} onStop={vi.fn()} status="question" {...handlers} {...next} />
  );
  const view = render(ui(props));
  return { ...handlers, ref, rerender: (next: BarProps) => view.rerender(ui(next)) };
}

const later = () => screen.getByRole("button", { name: /^Later/ });
const permissionGate = () => screen.queryByText("Run a shell command");
const questionGate = () => screen.queryByText("Which delimiter?");

describe("AgentPromptBar: Later on a phone gate", () => {
  it("folds a permission into a pending row, blocks Send, and Review brings it back", async () => {
    const user = userEvent.setup();
    const { ref, onSend, onGateClose, rerender } = renderBar({});
    // The request arrives while the user is in the composer.
    const editor = screen.getByRole("textbox");
    act(() => editor.focus());
    rerender({ pendingPermission: permission });
    expect(permissionGate()).toBeInTheDocument();
    const focusEditor = vi.spyOn(editor, "focus");

    await user.click(later());

    expect(permissionGate()).not.toBeInTheDocument();
    const review = screen.getByRole("button", { name: "Review" });
    expect(review).toHaveFocus();
    // The composer's focus restore stands down: the pending row keeps focus.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(focusEditor).not.toHaveBeenCalled();
    expect(review).toHaveFocus();

    await user.click(review);
    expect(permissionGate()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();

    await user.click(later());
    await act(async () => ref.current?.setDraft("Go on"));
    await user.click(screen.getByLabelText("Send message"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onGateClose).not.toHaveBeenCalled();
  });

  it("puts off and reopens a permission and a question pending together, each on its own", async () => {
    const user = userEvent.setup();
    renderBar({ pendingPermission: permission, pendingQuestions: questions });
    expect(permissionGate()).toBeInTheDocument();

    await user.click(later());
    // The question waiting behind the permission takes the composer's place.
    expect(permissionGate()).not.toBeInTheDocument();
    expect(questionGate()).toBeInTheDocument();

    await user.click(later());
    expect(questionGate()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(questionGate()).toBeInTheDocument();
    expect(permissionGate()).not.toBeInTheDocument();

    await user.click(later());
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(permissionGate()).toBeInTheDocument();
    expect(questionGate()).not.toBeInTheDocument();

    // Putting the permission off again leaves the question put off.
    await user.click(later());
    expect(screen.getByRole("button", { name: "Answer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("shows a new request with the same fallback key once the one put off is answered", async () => {
    const user = userEvent.setup();
    const { ref, onSend, rerender } = renderBar({ pendingPermission: permission });
    await user.click(later());
    expect(permissionGate()).not.toBeInTheDocument();

    rerender({ pendingPermission: null });
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    await act(async () => ref.current?.setDraft("Next step"));
    await user.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    rerender({ pendingPermission: { ...permission } });
    expect(permissionGate()).toBeInTheDocument();
  });
});
