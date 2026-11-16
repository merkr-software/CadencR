// @vitest-environment happy-dom
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

  it("reveals the PTY before file opening finishes, then focuses the editor", async () => {
    let resolveStart!: () => void;
    let resolveOpen!: () => void;
    mocks.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );
    mocks.open.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    const reveal = vi.fn(() => {
      addEditor(2);
    });
    const { result } = renderHook(() => useOpenFileInNeovim(2, { ensureStarted: true }));
    act(() => result.current?.("main.rs", 4, undefined, reveal));
    expect(mocks.start).toHaveBeenCalledWith(2);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => resolveStart());
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
    expect(mocks.dismiss).not.toHaveBeenCalled();
    await act(async () => resolveOpen());
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(hosts[0]);
  });

  it.each(["start", "open"] as const)(
    "surfaces %s failure and clears loading",
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error("unavailable"));
      const reveal = vi.fn();
      const { result } = renderHook(() => useOpenFileInNeovim(2, { ensureStarted: true }));
      await act(async () => result.current?.("main.rs", undefined, undefined, reveal));
      expect(mocks.error).toHaveBeenCalledWith("Could not open main.rs in Neovim", {
        description: "unavailable",
      });
      expect(mocks.dismiss).toHaveBeenCalledWith("pending");
      if (operation === "start") {
        expect(mocks.open).not.toHaveBeenCalled();
        expect(reveal).not.toHaveBeenCalled();
      } else {
        expect(reveal).toHaveBeenCalledOnce();
      }
    },
  );

  it("shows the backend explanation when a file-open request is rejected", async () => {
    mocks.open.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { data: { error: "Bad request: Path is outside the project directory" } },
      }),
    );
    const reveal = vi.fn();
    const { result } = renderHook(() => useOpenFileInNeovim(2));

    await act(async () => result.current?.("/docs/report.md", undefined, undefined, reveal));

    expect(mocks.open).toHaveBeenCalledWith({
      featureId: "2",
      data: { path: "/docs/report.md", line: undefined, col: undefined },
    });
    expect(mocks.error).toHaveBeenCalledWith("Could not open /docs/report.md in Neovim", {
      description: "Bad request: Path is outside the project directory",
    });
    expect(mocks.dismiss).toHaveBeenCalledWith("pending");
    expect(reveal).toHaveBeenCalledOnce();
  });

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
