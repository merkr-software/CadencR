// @vitest-environment happy-dom
/**
 * Behaviour tests for `useWorktreeTerminalAutoSwitch`.
 *
 * The hook reconciles open terminal panes against a freshly-changed expected
 * cwd (e.g. a new worktree): idle shells auto-restart, busy shells warn, and
 * an activity lookup failure falls back to warning (never a silent kill).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { TerminalLeaf } from "@/hooks/terminal-tree";

const fetchTerminalSessions = vi.fn();

vi.mock("@/api/terminal-sessions", () => ({
  fetchTerminalSessions: (...args: unknown[]) => fetchTerminalSessions(...args),
}));

import { useWorktreeTerminalAutoSwitch } from "./useWorktreeTerminalAutoSwitch";

function leaf(overrides: Partial<TerminalLeaf>): TerminalLeaf {
  return { type: "leaf", id: "pane-1", ptyId: "pty-1", cwd: "/repo", ...overrides };
}

describe("useWorktreeTerminalAutoSwitch", () => {
  beforeEach(() => {
    fetchTerminalSessions.mockReset();
  });

  it("auto-restarts an idle pane and never warns", async () => {
    fetchTerminalSessions.mockResolvedValue([
      { pty_id: "pty-1", cwd: "/repo", alive: true, foreground_active: false },
    ]);
    const onRestartPane = vi.fn();
    const { result } = renderHook(() =>
      useWorktreeTerminalAutoSwitch({
        featureId: 1,
        expectedCwd: "/repo/.worktrees/feat",
        leaves: [leaf({})],
        onRestartPane,
      }),
    );

    await waitFor(() => expect(onRestartPane).toHaveBeenCalledWith("pane-1"));
    expect(result.current.has("pane-1")).toBe(false);
  });

  it("warns for a busy pane instead of restarting it", async () => {
    fetchTerminalSessions.mockResolvedValue([
      { pty_id: "pty-1", cwd: "/repo", alive: true, foreground_active: true },
    ]);
    const onRestartPane = vi.fn();
    const { result } = renderHook(() =>
      useWorktreeTerminalAutoSwitch({
        featureId: 1,
        expectedCwd: "/repo/.worktrees/feat",
        leaves: [leaf({})],
        onRestartPane,
      }),
    );

    await waitFor(() => expect(result.current.has("pane-1")).toBe(true));
    expect(onRestartPane).not.toHaveBeenCalled();
  });

  it("falls back to warning when the activity lookup fails", async () => {
    fetchTerminalSessions.mockRejectedValue(new Error("offline"));
    const onRestartPane = vi.fn();
    const { result } = renderHook(() =>
      useWorktreeTerminalAutoSwitch({
        featureId: 1,
        expectedCwd: "/repo/.worktrees/feat",
        leaves: [leaf({})],
        onRestartPane,
      }),
    );

    await waitFor(() => expect(result.current.has("pane-1")).toBe(true));
    expect(onRestartPane).not.toHaveBeenCalled();
  });

  it("ignores panes whose cwd already matches the expected cwd", async () => {
    const onRestartPane = vi.fn();
    renderHook(() =>
      useWorktreeTerminalAutoSwitch({
        featureId: 1,
        expectedCwd: "/repo",
        leaves: [leaf({ cwd: "/repo" })],
        onRestartPane,
      }),
    );

    await Promise.resolve();
    expect(fetchTerminalSessions).not.toHaveBeenCalled();
    expect(onRestartPane).not.toHaveBeenCalled();
  });

  it("leaves a dismissed warning alone (no re-check, no restart)", async () => {
    const onRestartPane = vi.fn();
    renderHook(() =>
      useWorktreeTerminalAutoSwitch({
        featureId: 1,
        expectedCwd: "/repo/.worktrees/feat",
        leaves: [leaf({ cwdWarningDismissed: true })],
        onRestartPane,
      }),
    );

    await Promise.resolve();
    expect(fetchTerminalSessions).not.toHaveBeenCalled();
    expect(onRestartPane).not.toHaveBeenCalled();
  });
});
