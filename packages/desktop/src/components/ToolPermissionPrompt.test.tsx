import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { invokeRegisteredHotkey } from "@/test/hotkeys";
import React, { useState } from "react";
import { ToolPermissionPrompt } from "./ToolPermissionPrompt";
import type { PendingPermission } from "@/types/agent-permission";

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));

const mockedUseHotkeys = vi.mocked(useHotkeys);

interface RegisteredHotkey {
  callback: (event: KeyboardEvent) => void;
  hotkey: string;
}

function registeredHotkeys(): RegisteredHotkey[] {
  return mockedUseHotkeys.mock.calls.flatMap(([definitions]) =>
    definitions.map((definition) => ({
      callback: (event: KeyboardEvent) =>
        invokeRegisteredHotkey(definition.callback, String(definition.hotkey), event),
      hotkey: String(definition.hotkey),
    })),
  );
}

function findRegisteredHotkey(hotkey: string): RegisteredHotkey {
  const match = registeredHotkeys().find((definition) => definition.hotkey === hotkey);
  if (!match) throw new Error(`Expected hotkey ${hotkey} to be registered`);
  return match;
}

const permission: PendingPermission = {
  toolName: "Bash",
  input: { command: "ls -la" },
  description: "Run a shell command in your project",
  pattern: "Bash(ls*)",
  options: [
    {
      decision: "allow_once",
      label: "Allow once",
      description: "Approve this tool call only",
      collectFeedback: false,
    },
    {
      decision: "allow_future",
      label: "Always allow",
      description: "Let OpenCode allow similar requests automatically",
      collectFeedback: false,
    },
    { decision: "deny", label: "Deny", description: "Reject this request", collectFeedback: false },
  ],
};

const codexMcpPermission: PendingPermission = {
  ...permission,
  options: [
    {
      decision: "allow_once",
      optionId: 'codex_elicitation:{"action":"accept","content":{"approved":true}}',
      label: "Approve",
      description: "Accept this MCP elicitation",
      collectFeedback: false,
    },
    {
      decision: "allow_future",
      optionId:
        'codex_elicitation:{"action":"accept","content":{"approved":true},"_meta":{"persist":"session"}}',
      label: "Approve for session",
      description: "Accept matching MCP approvals for this Codex session",
      collectFeedback: false,
    },
    {
      decision: "allow_future",
      optionId:
        'codex_elicitation:{"action":"accept","content":{"approved":true},"_meta":{"persist":"always"}}',
      label: "Always approve",
      description: "Accept and let Codex persist this MCP approval",
      collectFeedback: false,
    },
    {
      decision: "deny",
      optionId: 'codex_elicitation:{"action":"decline","content":null}',
      label: "Deny and continue",
      description: "Decline this MCP elicitation",
      collectFeedback: false,
    },
    {
      decision: "deny",
      optionId: 'codex_elicitation:{"action":"cancel","content":null}',
      label: "Cancel",
      description: "Cancel this MCP elicitation",
      collectFeedback: true,
    },
  ],
};

describe("ToolPermissionPrompt", () => {
  beforeEach(() => {
    mockedUseHotkeys.mockClear();
  });

  it("renders tool name", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("renders description", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    expect(screen.getByText("Run a shell command in your project")).toBeInTheDocument();
  });

  it("renders command preview from input when preview is missing", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    expect(screen.getByText("ls -la")).toBeInTheDocument();
  });

  it("renders command preview from nested OpenCode metadata args", () => {
    render(
      <ToolPermissionPrompt
        permission={{
          ...permission,
          input: { metadata: { args: { command: ["git", "status", "--short"] } } },
        }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("git status --short")).toBeInTheDocument();
  });

  it("falls back to raw input JSON when no known preview key is present", () => {
    render(
      <ToolPermissionPrompt
        permission={{
          ...permission,
          input: { invocation: { executable: "unknown-shape", argv: ["run"] } },
        }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText(/unknown-shape/)).toBeInTheDocument();
  });

  it("renders three permission options", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    expect(screen.getByText("Allow once")).toBeInTheDocument();
    expect(screen.getByText("Always allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("calls onDecision with allow_once when Allow once clicked", async () => {
    const onDecision = vi.fn();
    const { user } = render(
      <ToolPermissionPrompt permission={permission} onDecision={onDecision} />,
    );
    await user.click(screen.getByText("Allow once").closest("button")!);
    expect(onDecision).toHaveBeenCalledWith("allow_once");
  });

  it("calls onDecision with allow_future when Allow for future clicked", async () => {
    const onDecision = vi.fn();
    const { user } = render(
      <ToolPermissionPrompt permission={permission} onDecision={onDecision} />,
    );
    await user.click(screen.getByText("Always allow").closest("button")!);
    expect(onDecision).toHaveBeenCalledWith("allow_future");
  });

  it("submits deny immediately when feedback is not requested", async () => {
    const onDecision = vi.fn();
    const { user } = render(
      <ToolPermissionPrompt permission={permission} onDecision={onDecision} />,
    );
    await user.click(screen.getByText("Deny").closest("button")!);
    expect(onDecision).toHaveBeenCalledWith("deny", undefined);
    expect(screen.queryByPlaceholderText(/reason for denying/i)).not.toBeInTheDocument();
  });

  it("shows feedback input when deny requests it", async () => {
    const permissionWithFeedback: PendingPermission = {
      ...permission,
      options: permission.options?.map((option) =>
        option.decision === "deny" ? { ...option, collectFeedback: true } : option,
      ),
    };
    const { user } = render(
      <ToolPermissionPrompt permission={permissionWithFeedback} onDecision={vi.fn()} />,
    );
    await user.click(screen.getByText("Deny").closest("button")!);
    expect(screen.getByPlaceholderText(/reason for denying/i)).toBeInTheDocument();
  });

  it("calls onDecision with deny after pressing Enter in feedback", async () => {
    const onDecision = vi.fn();
    const permissionWithFeedback: PendingPermission = {
      ...permission,
      options: permission.options?.map((option) =>
        option.decision === "deny" ? { ...option, collectFeedback: true } : option,
      ),
    };
    const { user } = render(
      <ToolPermissionPrompt permission={permissionWithFeedback} onDecision={onDecision} />,
    );
    await user.click(screen.getByText("Deny").closest("button")!);
    const input = screen.getByPlaceholderText(/reason for denying/i);
    await user.type(input, "Too risky");
    await user.keyboard("{Enter}");
    expect(onDecision).toHaveBeenCalledWith("deny", "Too risky");
  });

  it("shows runtime-specific option description", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    expect(
      screen.getByText("Let OpenCode allow similar requests automatically"),
    ).toBeInTheDocument();
  });

  it("shows nested metadata command preview", () => {
    render(
      <ToolPermissionPrompt
        permission={{
          ...permission,
          preview: "git status",
        }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("git status")).toBeInTheDocument();
  });

  it("shows provided path preview", () => {
    render(
      <ToolPermissionPrompt
        permission={{
          ...permission,
          toolName: "external_directory",
          preview: "/etc/hosts",
        }}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("/etc/hosts")).toBeInTheDocument();
  });

  it("registers Mod+Y, Mod+L, and Mod+N hotkeys (no Mod+digit)", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    const hotkeyStrings = registeredHotkeys().map((definition) => definition.hotkey);
    expect(hotkeyStrings).toContain("Mod+Y");
    expect(hotkeyStrings).toContain("Mod+L");
    expect(hotkeyStrings).toContain("Mod+N");
    // Mod+digit shortcuts must be gone — they're reserved for the sidebar.
    expect(hotkeyStrings.some((s) => /^Mod\+\d$/.test(s))).toBe(false);
  });

  it("clicking the dismiss button invokes onCancel", async () => {
    const onCancel = vi.fn();
    const { user } = render(
      <ToolPermissionPrompt permission={permission} onDecision={vi.fn()} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole("button", { name: /dismiss permission request/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("dismiss button still closes the gate while submitting", async () => {
    const onCancel = vi.fn();
    const { user } = render(
      <ToolPermissionPrompt
        permission={permission}
        onDecision={vi.fn()}
        onCancel={onCancel}
        isSubmitting={true}
      />,
    );
    const dismissButton = screen.getByRole("button", { name: /dismiss permission request/i });
    expect(dismissButton).not.toBeDisabled();
    await user.click(dismissButton);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps permission decision buttons disabled while submitting", () => {
    render(
      <ToolPermissionPrompt
        permission={permission}
        onDecision={vi.fn()}
        onCancel={vi.fn()}
        isSubmitting={true}
      />,
    );
    expect(screen.getByRole("button", { name: /allow once/i })).toBeDisabled();
  });

  it("does not render a dismiss button without onCancel", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /dismiss permission request/i })).toBeNull();
  });

  it("invoking Escape closes the permission gate even while submitting", () => {
    const onCancel = vi.fn();
    render(
      <ToolPermissionPrompt
        permission={permission}
        onDecision={vi.fn()}
        onCancel={onCancel}
        isSubmitting={true}
      />,
    );
    const handler = findRegisteredHotkey("Escape").callback as unknown as (e: {
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void;
    handler({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("invoking Mod+Y handler approves with allow_once", () => {
    const onDecision = vi.fn();
    vi.useFakeTimers();
    try {
      render(<ToolPermissionPrompt permission={permission} onDecision={onDecision} />);
      const handler = findRegisteredHotkey("Mod+Y").callback as unknown as (e: {
        preventDefault: () => void;
      }) => void;
      handler({ preventDefault: vi.fn() });
      vi.runAllTimers();
      expect(onDecision).toHaveBeenCalledWith("allow_once");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invoking Mod+L handler approves with allow_future", () => {
    const onDecision = vi.fn();
    vi.useFakeTimers();
    try {
      render(<ToolPermissionPrompt permission={permission} onDecision={onDecision} />);
      const handler = findRegisteredHotkey("Mod+L").callback as unknown as (e: {
        preventDefault: () => void;
      }) => void;
      handler({ preventDefault: vi.fn() });
      vi.runAllTimers();
      expect(onDecision).toHaveBeenCalledWith("allow_future");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invoking shifted Mod+Y handler does not approve with allow_once", () => {
    const onDecision = vi.fn();
    vi.useFakeTimers();
    try {
      render(<ToolPermissionPrompt permission={permission} onDecision={onDecision} />);
      const handler = findRegisteredHotkey("Mod+Y").callback as unknown as (e: {
        preventDefault: () => void;
        shiftKey: boolean;
      }) => void;
      handler({ preventDefault: vi.fn(), shiftKey: true });
      vi.runAllTimers();
      expect(onDecision).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invoking Mod+N handler triggers deny flow", () => {
    const onDecision = vi.fn();
    vi.useFakeTimers();
    try {
      render(<ToolPermissionPrompt permission={permission} onDecision={onDecision} />);
      const handler = findRegisteredHotkey("Mod+N").callback as unknown as (e: {
        preventDefault: () => void;
      }) => void;
      handler({ preventDefault: vi.fn() });
      vi.runAllTimers();
      expect(onDecision).toHaveBeenCalledWith("deny", undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders cmd+Y, cmd+L, and cmd+N shortcut badges", () => {
    render(<ToolPermissionPrompt permission={permission} onDecision={vi.fn()} />);
    const allowOnceBtn = screen.getByText("Allow once").closest("button")!;
    const alwaysAllowBtn = screen.getByText("Always allow").closest("button")!;
    const denyBtn = screen.getByText("Deny").closest("button")!;

    expect(allowOnceBtn.querySelector("kbd")).not.toBeNull();
    expect(allowOnceBtn.textContent).toContain("Y");
    expect(denyBtn.querySelector("kbd")).not.toBeNull();
    expect(denyBtn.textContent).toContain("N");
    expect(alwaysAllowBtn.querySelector("kbd")).not.toBeNull();
    expect(alwaysAllowBtn.textContent).toContain("L");
  });

  it("only shortcuts persistent Codex MCP approval when session and always are both present", () => {
    render(<ToolPermissionPrompt permission={codexMcpPermission} onDecision={vi.fn()} />);
    const sessionBtn = screen.getByText("Approve for session").closest("button")!;
    const alwaysBtn = screen.getByText("Always approve").closest("button")!;

    expect(sessionBtn.querySelector("kbd")).toBeNull();
    expect(alwaysBtn.querySelector("kbd")).not.toBeNull();
    expect(alwaysBtn.textContent).toContain("L");
  });

  it("invoking Mod+L uses the persistent Codex MCP approval option", () => {
    const onDecision = vi.fn();
    vi.useFakeTimers();
    try {
      render(<ToolPermissionPrompt permission={codexMcpPermission} onDecision={onDecision} />);
      const handler = findRegisteredHotkey("Mod+L").callback as unknown as (e: {
        preventDefault: () => void;
      }) => void;
      handler({ preventDefault: vi.fn() });
      vi.runAllTimers();
      expect(onDecision).toHaveBeenCalledWith(
        "allow_future",
        undefined,
        'codex_elicitation:{"action":"accept","content":{"approved":true},"_meta":{"persist":"always"}}',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("only shortcuts Deny and continue, not Cancel, for Codex MCP options", () => {
    render(<ToolPermissionPrompt permission={codexMcpPermission} onDecision={vi.fn()} />);
    const denyAndContinueBtn = screen.getByText("Deny and continue").closest("button")!;
    const cancelBtn = screen.getByText("Cancel").closest("button")!;

    expect(denyAndContinueBtn.querySelector("kbd")).not.toBeNull();
    expect(denyAndContinueBtn.textContent).toContain("N");
    expect(cancelBtn.querySelector("kbd")).toBeNull();
  });

  it("invoking Mod+N uses Deny and continue instead of Cancel for Codex MCP options", () => {
    const onDecision = vi.fn();
    vi.useFakeTimers();
    try {
      render(<ToolPermissionPrompt permission={codexMcpPermission} onDecision={onDecision} />);
      const handler = findRegisteredHotkey("Mod+N").callback as unknown as (e: {
        preventDefault: () => void;
      }) => void;
      handler({ preventDefault: vi.fn() });
      vi.runAllTimers();
      expect(onDecision).toHaveBeenCalledWith(
        "deny",
        undefined,
        'codex_elicitation:{"action":"decline","content":null}',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables every option button while isSubmitting is true", () => {
    render(
      <ToolPermissionPrompt permission={permission} onDecision={vi.fn()} isSubmitting={true} />,
    );
    for (const label of ["Allow once", "Always allow", "Deny"]) {
      const btn = screen.getByText(label).closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
  });

  it("ignores option clicks while isSubmitting is true", async () => {
    const onDecision = vi.fn();
    const { user } = render(
      <ToolPermissionPrompt permission={permission} onDecision={onDecision} isSubmitting={true} />,
    );
    await user.click(screen.getByText("Allow once").closest("button")!);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("shows a spinner on the clicked option while submission is in flight", async () => {
    function Harness(): React.ReactElement {
      const [submitting, setSubmitting] = useState(false);
      return (
        <ToolPermissionPrompt
          permission={permission}
          onDecision={() => setSubmitting(true)}
          isSubmitting={submitting}
        />
      );
    }
    const { user } = render(<Harness />);
    const allowOnceBtn = screen.getByText("Allow once").closest("button") as HTMLButtonElement;
    await user.click(allowOnceBtn);
    // After the click, the parent flips isSubmitting; the clicked button now
    // shows aria-busy and is disabled.
    expect(allowOnceBtn.disabled).toBe(true);
    expect(allowOnceBtn.getAttribute("aria-busy")).toBe("true");
    // The other buttons are disabled but not busy.
    const denyBtn = screen.getByText("Deny").closest("button") as HTMLButtonElement;
    expect(denyBtn.disabled).toBe(true);
    expect(denyBtn.getAttribute("aria-busy")).toBe("false");
  });
});
