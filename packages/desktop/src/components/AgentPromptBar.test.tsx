import { forwardRef, useImperativeHandle, useRef, useState, type ForwardedRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useStopArmStore } from "@/stores/stop-arm-store";
import { act, fireEvent, render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { formatKey } from "@/lib/shortcuts/format";
import { AgentPromptBar } from "./AgentPromptBar";
import type { PromptCommandPolicy } from "@/lib/prompt-command-policy";
import type { HotkeyCallback } from "@tanstack/hotkeys";
import { invokeRegisteredHotkey } from "@/test/hotkeys";

const DOLLAR_SKILLS_POLICY: PromptCommandPolicy = {
  slashCommandPlacement: "prompt_start",
  skillReferenceTrigger: "dollar",
  userShell: true,
};
const SHELL_POLICY: PromptCommandPolicy = {
  slashCommandPlacement: "prompt_start",
  skillReferenceTrigger: "slash",
  userShell: true,
};

const isMobileMock = vi.fn(() => false);
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileMock(),
}));

interface HotkeyEntry {
  handler: (e: Partial<KeyboardEvent>) => void;
  options?: { enabled?: boolean };
}
interface HotkeyDefinition {
  callback: HotkeyCallback;
  hotkey: string;
  options?: { enabled?: boolean };
}
const hotkeyHandlers = new Map<string, HotkeyEntry>();
vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn((definitions: HotkeyDefinition[]) => {
    definitions.forEach((definition) => {
      hotkeyHandlers.set(definition.hotkey, {
        handler: (event) => invokeRegisteredHotkey(definition.callback, definition.hotkey, event),
        options: definition.options,
      });
    });
  }),
}));

function callHotkey(key: string, e: Partial<KeyboardEvent> = { preventDefault: vi.fn() }): void {
  const entry = hotkeyHandlers.get(key);
  if (!entry) throw new Error(`hotkey ${key} not registered`);
  if (entry.options?.enabled === false) return;
  entry.handler(e);
}

// Mock all tRPC-using hooks directly to avoid cascading mock complexity
vi.mock("@/hooks/usePromptDraft", () => ({
  usePromptDraft: vi.fn(() => ({ saveDraft: vi.fn(), initialDraft: null, draftFeatureId: null })),
}));

vi.mock("@/hooks/usePromptHistory", () => ({
  usePromptHistory: vi.fn(() => ({
    addEntry: vi.fn(),
    history: [],
    navigateUp: vi.fn(),
    navigateDown: vi.fn(),
    reset: vi.fn(),
    resetNavigation: vi.fn(),
  })),
}));

vi.mock("@/hooks/useFileMention", () => ({
  useFileMention: vi.fn(() => ({
    open: false,
    query: "",
    filteredFiles: [],
    selectedIndex: 0,
    handleKeyDown: vi.fn(),
    handleChange: vi.fn(),
    selectFile: vi.fn(),
    triggerMention: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@/hooks/useSlashCommand", () => ({
  useSlashCommand: vi.fn(() => ({
    open: false,
    query: "",
    filteredCommands: [],
    selectedIndex: 0,
    handleKeyDown: vi.fn(),
    handleChange: vi.fn(),
    selectCommand: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@/hooks/useImageAttachments", () => ({
  useImageAttachments: vi.fn(() => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    dragHandlers: {},
    isDragging: false,
  })),
}));

vi.mock("./prompt-editor/PromptEditor", () => {
  const MockPromptEditor = forwardRef(function MockPromptEditor(
    {
      initialText,
      onChange,
      placeholder,
      disabled,
    }: {
      initialText?: string;
      onChange?: (text: string) => void;
      placeholder?: string;
      disabled?: boolean;
    },
    ref: ForwardedRef<{
      focus: () => void;
      blur: () => void;
      clear: () => void;
      setText: (text: string) => void;
      getText: () => string;
      clearShellCommandMode: () => void;
    }>,
  ) {
    const [value, setValue] = useState(
      initialText?.startsWith("!") ? initialText.slice(1) : (initialText ?? ""),
    );
    const [shellMode, setShellMode] = useState(initialText?.startsWith("!") ?? false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const replaceText = (text: string): void => {
      const nextShellMode = text.startsWith("!");
      setShellMode(nextShellMode);
      setValue(nextShellMode ? text.slice(1) : text);
      onChange?.(text);
    };

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        blur: () => textareaRef.current?.blur(),
        clear: () => {
          setValue("");
          setShellMode(false);
          onChange?.("");
        },
        setText: replaceText,
        getText: () => (shellMode ? `!${value}` : value),
        clearShellCommandMode: () => {
          setShellMode(false);
          onChange?.(value);
        },
      }),
      [onChange, shellMode, value],
    );

    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (!shellMode && nextValue.startsWith("!")) {
            replaceText(nextValue);
            return;
          }
          setValue(nextValue);
          onChange?.(shellMode ? `!${nextValue}` : nextValue);
        }}
        placeholder={placeholder}
        disabled={disabled}
      />
    );
  });

  return { PromptEditor: MockPromptEditor };
});

describe("AgentPromptBar", () => {
  const onSend = vi.fn();
  const onStop = vi.fn();

  beforeEach(() => {
    useStopArmStore.getState().disarm();
    onSend.mockClear();
    onStop.mockClear();
    isMobileMock.mockReturnValue(false);
    hotkeyHandlers.clear();
  });

  it("renders textarea", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("does not advertise unsupported shell commands or dollar skills", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Message the agent — @ files, @@ conversations, / commands",
    );
  });

  it("advertises dollar skill references for Codex", () => {
    render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        promptCommandPolicy={DOLLAR_SKILLS_POLICY}
      />,
    );

    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Message the agent — @ files, @@ conversations, / commands, $ skills, ! shell",
    );
  });

  it("enters a removable shell mode while preserving the serialized bang", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        promptCommandPolicy={SHELL_POLICY}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "!printf shell-ok" } });

    const surface = container.querySelector('[data-shell-command-mode="true"]');
    expect(surface).not.toBeNull();
    // The mode surfaces through the minimal leading prompt marker, not a
    // heavy tint/glow on the whole bar.
    expect(screen.getByLabelText("Exit shell command mode")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("printf shell-ok");
    expect(screen.getByLabelText("Attach files")).toBeDisabled();
    expect(screen.getByLabelText("Send message")).toBeEnabled();

    await user.click(screen.getByLabelText("Send message"));
    expect(onSend).toHaveBeenCalledWith("!printf shell-ok", undefined);
  });

  it("exits shell mode without clearing the command text", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        promptCommandPolicy={SHELL_POLICY}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "!git status" } });

    await user.click(screen.getByLabelText("Exit shell command mode"));

    expect(container.querySelector('[data-shell-command-mode="true"]')).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("git status");
    await user.click(screen.getByLabelText("Send message"));
    expect(onSend).toHaveBeenCalledWith("git status", undefined);
  });

  it("does not send an empty shell command", () => {
    render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        promptCommandPolicy={SHELL_POLICY}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "!" } });

    expect(screen.getByLabelText("Exit shell command mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("uses the ordinary send action instead of split actions in shell mode", async () => {
    const splitAction = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        promptCommandPolicy={SHELL_POLICY}
        splitSendActions={[{ label: "Send to child", icon: null, onClick: splitAction }]}
      />,
    );

    await user.type(screen.getByRole("textbox"), "!printf direct");

    expect(screen.queryByRole("button", { name: "Send to child" })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Send message"));
    expect(onSend).toHaveBeenCalledWith("!printf direct", undefined);
    expect(splitAction).not.toHaveBeenCalled();
  });

  it("shows buttons when idle", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("turns Send into Steer beside a labelled Stop while running", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />);
    expect(screen.getByLabelText("Stop agent")).toHaveTextContent("Stop");
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Steer the agent with this message")).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("states what Enter does while the agent works", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />);
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      expect.stringMatching(
        // ↵ on macOS, "Enter" on Linux.
        new RegExp(
          `^${formatKey("enter")} to steer the agent at its next step, .+ to queue it after this turn$`,
        ),
      ),
    );
    // One verb per key: no dash for the reader to parse.
    expect(screen.getByRole("textbox").getAttribute("placeholder")).not.toMatch(/[—–]/);
  });

  it("keeps steer available beside stop while running on mobile", async () => {
    isMobileMock.mockReturnValue(true);
    const user = userEvent.setup();
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />);

    expect(screen.getByLabelText("Stop agent")).toBeInTheDocument();
    const sendButton = screen.getByLabelText("Steer the agent with this message");
    expect(sendButton).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "Follow up");
    expect(sendButton).toBeEnabled();
    await user.click(sendButton);

    expect(onSend).toHaveBeenCalledWith("Follow up", undefined);
  });

  it("renders send button that is disabled when empty", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);
    const sendButton = screen.getByLabelText("Send message");
    expect(sendButton).toBeDisabled();
  });

  it("focuses the input when clicking the gray prompt surface", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);
    const textbox = screen.getByRole("textbox");
    const surface = textbox.parentElement;
    expect(surface).toBeInstanceOf(HTMLElement);
    fireEvent.click(surface!);
    expect(document.activeElement).toBe(textbox);
  });

  it("does not focus the input when clicking prompt controls", () => {
    render(
      <div>
        <button data-testid="outside">Outside</button>
        <AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />
      </div>,
    );
    const textbox = screen.getByRole("textbox");
    screen.getByTestId("outside").focus();
    fireEvent.click(screen.getByLabelText("Attach files"));
    expect(document.activeElement).not.toBe(textbox);
  });

  it("does not call onSend when text is empty and Enter pressed", async () => {
    const user = userEvent.setup();
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);
    await user.type(screen.getByRole("textbox"), "{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows question drawer when pending questions provided", () => {
    render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="question"
        pendingQuestions={[{ question: "What do you need?" }]}
        onQuestionResponse={vi.fn()}
      />,
    );
    expect(screen.getByText(/What do you need/)).toBeInTheDocument();
  });

  it("renders permission prompt when pendingPermission is provided", () => {
    render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="agent"
        pendingPermission={{
          toolName: "Bash",
          input: { command: "ls /tmp" },
          description: "Run a bash command",
          pattern: "Bash(/tmp:*)",
          requestId: "req-1",
        }}
        onPermissionDecision={vi.fn()}
      />,
    );
    expect(screen.getByText(/Permission Required/)).toBeInTheDocument();
    expect(screen.getByText(/Allow once/)).toBeInTheDocument();
    // The regular prompt textarea should not be rendered
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps the schedules in view above a permission prompt", () => {
    render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="agent"
        schedules={<section aria-label="Scheduled messages">Sends in 5 min</section>}
        pendingPermission={{
          toolName: "Bash",
          input: { command: "ls /tmp" },
          description: "Run a bash command",
          pattern: "Bash(/tmp:*)",
          requestId: "req-1",
        }}
        onPermissionDecision={vi.fn()}
      />,
    );
    // Once above the gate; the composer's own copy is hidden with it.
    expect(screen.getAllByRole("region", { name: "Scheduled messages" })).toHaveLength(1);
    expect(screen.getByText(/Permission Required/)).toBeInTheDocument();
  });

  it("starts empty when the feature draft hook has no draft", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);
    expect(screen.getByRole("textbox")).toHaveTextContent("");
  });

  it("restores unsent text after a permission prompt closes", async () => {
    const { rerender } = render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft" } });

    rerender(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="agent"
        pendingPermission={{
          toolName: "Bash",
          input: { command: "ls /tmp" },
          description: "Run a bash command",
          pattern: "Bash(/tmp:*)",
          requestId: "req-1",
        }}
        onPermissionDecision={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    expect(screen.getByText(/Permission request pending/i)).toBeInTheDocument();

    rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
  });

  it("restores unsent text after plan approval closes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

    try {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Need a smaller plan" } });

      rerender(
        <AgentPromptBar
          onSend={onSend}
          onStop={onStop}
          status="question"
          pendingPlanApproval={{ allowedPrompts: [] }}
          onPlanApprove={vi.fn()}
          onPlanRequestChanges={vi.fn()}
        />,
      );

      expect(screen.getByText(/Plan approval pending/i)).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("Need a smaller plan");
      await act(async () => vi.advanceTimersByTime(1000));
      expect(screen.getByText(/Plan ready for review/i)).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

      rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

      expect(screen.getByRole("textbox")).toHaveValue("Need a smaller plan");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores unsent text after question drawer closes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

    try {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Answer later" } });
      rerender(
        <AgentPromptBar
          onSend={onSend}
          onStop={onStop}
          status="question"
          pendingQuestions={[{ question: "What do you need?", options: [{ label: "Option A" }] }]}
          onQuestionResponse={vi.fn()}
        />,
      );

      expect(screen.getByText(/Question pending/i)).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("Answer later");
      await act(async () => vi.advanceTimersByTime(1000));
      expect(screen.getByText(/What do you need/i)).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

      rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" />);

      expect(screen.getByRole("textbox")).toHaveValue("Answer later");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second escape inside the arm window stops the agent; one press only arms", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />);
    screen.getByRole("textbox").focus();
    const entry = hotkeyHandlers.get("Escape");
    expect(entry).toBeDefined();
    act(() => entry!.handler({ preventDefault: vi.fn() }));
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/press\s*esc\s*again to stop/i);
    entry!.handler({ preventDefault: vi.fn() });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("escape never stops while a composer popover owns it", () => {
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />);
    const textbox = screen.getByRole("textbox");
    const popover = document.createElement("div");
    popover.setAttribute("data-composer-popover", "");
    textbox.closest("[data-agent-prompt-bar]")!.appendChild(popover);
    textbox.focus();
    const entry = hotkeyHandlers.get("Escape")!;
    entry.handler({ preventDefault: vi.fn() });
    entry.handler({ preventDefault: vi.fn() });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("escape does not call onStop when focus is outside the prompt bar", () => {
    render(
      <div>
        <button data-testid="outside">Outside</button>
        <AgentPromptBar onSend={onSend} onStop={onStop} status="agent" />
      </div>,
    );
    screen.getByTestId("outside").focus();
    const entry = hotkeyHandlers.get("Escape");
    expect(entry).toBeDefined();
    entry!.handler({ preventDefault: vi.fn() });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("agent-menu hotkeys fire by default and are no-ops when agentTabActive is false", () => {
    const onOpenModelPicker = vi.fn();
    const onPermissionModeToggle = vi.fn();
    const onToggleMaximize = vi.fn();
    const props = {
      onSend,
      onStop,
      status: "idle" as const,
      onOpenModelPicker,
      onPermissionModeToggle,
      onToggleMaximize,
    };

    const { rerender } = render(<AgentPromptBar {...props} />);
    callHotkey("Mod+P");
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);

    rerender(<AgentPromptBar {...props} agentTabActive={false} />);
    callHotkey("Mod+P");
    callHotkey("Shift+Tab");
    callHotkey("Mod+Shift+Enter");
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1); // still 1, not 2
    expect(onPermissionModeToggle).not.toHaveBeenCalled();
    expect(onToggleMaximize).not.toHaveBeenCalled();
  });

  it("escape still works when agentTabActive is false (focus-gated, not tab-gated)", () => {
    render(
      <AgentPromptBar onSend={onSend} onStop={onStop} status="agent" agentTabActive={false} />,
    );
    screen.getByRole("textbox").focus();
    hotkeyHandlers.get("Escape")!.handler({ preventDefault: vi.fn() });
    hotkeyHandlers.get("Escape")!.handler({ preventDefault: vi.fn() });
    expect(onStop).toHaveBeenCalled();
  });
});
