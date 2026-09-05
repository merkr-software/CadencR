import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  start: vi.fn(),
  level: "2",
  mobile: false,
  loading: vi.fn(() => "pending"),
  dismiss: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/api/generated", () => ({
  useOpenFileRoute: () => ({ mutateAsync: mocks.open }),
  startRoute: mocks.start,
}));
vi.mock("sonner", () => ({
  toast: { loading: mocks.loading, dismiss: mocks.dismiss, error: mocks.error },
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("@/hooks/useVimModeLevel", () => ({ useVimModeLevel: () => mocks.level }));

import { useOpenFileInNeovim } from "./useOpenFileInNeovim";

const hosts: HTMLElement[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.level = "2";
  mocks.mobile = false;
  mocks.open.mockResolvedValue({});
  mocks.start.mockResolvedValue({});
});
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  vi.useRealTimers();
});

function addEditor(featureId: number): HTMLElement {
  const host = document.createElement("div");
  host.tabIndex = 0;
  host.dataset.neovimFeatureId = String(featureId);
  document.body.append(host);
  hosts.push(host);
  return host;
}

describe("shared Neovim file navigation", () => {
  it("focuses the renderer input when its host is not focusable", async () => {
    const host = addEditor(2);
    host.removeAttribute("tabindex");
    const input = document.createElement("textarea");
    host.append(input);
    const { result } = renderHook(() => useOpenFileInNeovim(2));
    await act(async () => result.current?.("main.rs"));
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(input);
  });

  it("focuses the requested feature rather than the first kept-alive editor", async () => {
    addEditor(1);
    const target = addEditor(2);
    const { result } = renderHook(() => useOpenFileInNeovim(2));
    await act(async () => result.current?.("src/main.ts", 7, 3));
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(target);
    expect(mocks.open).toHaveBeenCalledWith({
      featureId: "2",
      data: { path: "src/main.ts", line: 7, col: 3 },
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.loading).toHaveBeenCalledOnce();
    expect(mocks.dismiss).toHaveBeenCalledWith("pending");
  });

  it("waits for startup, opens, then reveals and focuses the newly mounted editor", async () => {
    let resolveStart!: () => void;
    mocks.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const reveal = vi.fn(() => {
      addEditor(2);
    });
    const { result } = renderHook(() =>
      useOpenFileInNeovim(2, { ensureStarted: true, onOpened: reveal }),
    );
    act(() => result.current?.("main.rs", 4));
    expect(mocks.start).toHaveBeenCalledWith(2);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => resolveStart());
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(hosts[0]);
  });

  it.each(["start", "open"] as const)(
    "surfaces %s failure and clears loading without revealing",
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error("unavailable"));
      const reveal = vi.fn();
      const { result } = renderHook(() =>
        useOpenFileInNeovim(2, { ensureStarted: true, onOpened: reveal }),
      );
      await act(async () => result.current?.("main.rs"));
      expect(mocks.error).toHaveBeenCalledWith("Could not open main.rs in Neovim", {
        description: "unavailable",
      });
      expect(mocks.dismiss).toHaveBeenCalledWith("pending");
      expect(reveal).not.toHaveBeenCalled();
      if (operation === "start") expect(mocks.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["0", false],
    ["1", false],
    ["2", true],
  ])("uses CodeMirror fallback for level %s, mobile %s", (level, mobile) => {
    mocks.level = String(level);
    mocks.mobile = Boolean(mobile);
    const { result } = renderHook(() => useOpenFileInNeovim(2));
    expect(result.current).toBeUndefined();
  });
});
