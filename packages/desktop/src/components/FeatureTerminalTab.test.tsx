import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/test-utils";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { FeatureTerminalTab } from "./FeatureTerminalTab";

const mocks = vi.hoisted(() => ({
  touch: false,
  focusActivePane: vi.fn(),
  focusFirstPane: vi.fn(),
}));

vi.mock("@/lib/form-factor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/form-factor")>()),
  getCoarsePointerSnapshot: () => mocks.touch,
}));
vi.mock("@/hooks/useShortcut", () => ({ useScopedGlobalShortcutById: vi.fn() }));
vi.mock("@/api/generated", () => ({ useListProjects: () => ({ data: [] }) }));
vi.mock("@/api/terminal-sessions", () => ({ fetchTerminalSessions: vi.fn(async () => []) }));
vi.mock("@/hooks/useFeatureWorktreePath", () => ({ useFeatureWorktreePath: () => null }));
vi.mock("@/components/terminal/TerminalPanel", () => ({
  TerminalPanel: forwardRef(function TerminalPanelStub(_props, ref) {
    useImperativeHandle(ref, () => ({
      focusActivePane: mocks.focusActivePane,
      focusFirstPane: mocks.focusFirstPane,
    }));
    return <div data-testid="terminal-panel" />;
  }),
}));

const FEATURE_ID = 41;

function renderFocusedTerminal() {
  return render(
    <FeatureTerminalTab featureId={FEATURE_ID} projectId={1} activeOverride focusedOverride />,
  );
}

describe("FeatureTerminalTab focus on activation", () => {
  beforeEach(() => {
    mocks.focusActivePane.mockClear();
    mocks.focusFirstPane.mockClear();
    useTerminalStore.getState().addPane(FEATURE_ID);
  });

  it("focuses the terminal when its tab becomes the focused one under a mouse", async () => {
    // Whatever the layout: a narrow Electron window renders the phone one.
    mocks.touch = false;
    renderFocusedTerminal();
    await waitFor(() => expect(mocks.focusActivePane).toHaveBeenCalled());
  });

  it("opens the terminal without focusing it under a finger", async () => {
    mocks.touch = true;
    renderFocusedTerminal();
    await waitFor(() =>
      expect(useTerminalStore.getState().getFeature(FEATURE_ID).isOpen).toBe(true),
    );
    // Past the frame a mouse-driven window focuses in.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.focusActivePane).not.toHaveBeenCalled();
  });
});
