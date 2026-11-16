// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionControls } from "@/components/WebSocketSessionControls";

const shortcuts = vi.hoisted(() => new Map<string, (event: KeyboardEvent) => void>());
vi.mock("@/hooks/useShortcut", () => ({
  useScopedShortcut: (id: string, callback: (event: KeyboardEvent) => void) => {
    shortcuts.set(id, callback);
  },
}));

import { useWsSessionShortcuts } from "./WebSocketSessionFeatureBlockHooks";

function controlsFor(supportsConfigInheritance: boolean) {
  const setThinkingEffort = vi.fn();
  const queueRuntimeOverride = vi.fn();
  const controls = {
    supportsConfigInheritance,
    supportedThinkingEfforts: ["low", "medium", "high", "xhigh"],
    ws: { currentThinkingEffort: "high", setThinkingEffort, queueRuntimeOverride },
  } as unknown as SessionControls;
  return { controls, setThinkingEffort, queueRuntimeOverride };
}

/** ⌘T with the focus in the composer. */
function pressCycleEffort(): void {
  const bar = document.createElement("div");
  bar.setAttribute("data-agent-prompt-bar", "true");
  const input = document.createElement("textarea");
  bar.append(input);
  document.body.append(bar);
  input.focus();
  shortcuts.get("agent-thinking")?.(new KeyboardEvent("keydown"));
}

afterEach(() => {
  document.body.innerHTML = "";
  shortcuts.clear();
});

describe("useWsSessionShortcuts thinking effort", () => {
  it("cycles a Codex effort through the runtime override, like the composer control", () => {
    const { controls, setThinkingEffort, queueRuntimeOverride } = controlsFor(true);
    renderHook(() => useWsSessionShortcuts({ controls, hotkeysEnabled: true }));
    pressCycleEffort();
    expect(queueRuntimeOverride).toHaveBeenCalledWith({ thinking_effort: "xhigh" });
    expect(setThinkingEffort).not.toHaveBeenCalled();
  });

  it("cycles a Claude effort through effort.set", () => {
    const { controls, setThinkingEffort, queueRuntimeOverride } = controlsFor(false);
    renderHook(() => useWsSessionShortcuts({ controls, hotkeysEnabled: true }));
    pressCycleEffort();
    expect(setThinkingEffort).toHaveBeenCalledWith("xhigh");
    expect(queueRuntimeOverride).not.toHaveBeenCalled();
  });
});
