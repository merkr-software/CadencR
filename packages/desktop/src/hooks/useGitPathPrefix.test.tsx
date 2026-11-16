import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as { prefix?: string | null; root?: string | null } | undefined,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  options: [] as Array<{ query: { enabled: boolean } }>,
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/api/generated", () => ({
  useGetGitPathPrefix: (_params: unknown, options: { query: { enabled: boolean } }) => {
    mocks.options.push(options);
    return mocks.query;
  },
}));

import { useAgentPathMapper } from "./useGitPathPrefix";

beforeEach(() => {
  mocks.query = { data: undefined, isError: false, error: null, refetch: vi.fn() };
  mocks.options = [];
  mocks.toastError.mockReset();
});

describe("useAgentPathMapper", () => {
  it("holds back until the paths are known", () => {
    const { result } = renderHook(() => useAgentPathMapper(3));
    expect(result.current).toBeUndefined();
  });

  it("names files from the agent's directory in a monorepo project", () => {
    mocks.query.data = { prefix: "packages/app", root: "/repo" };
    const { result } = renderHook(() => useAgentPathMapper(3));
    expect(result.current?.("packages/app/src/a.ts")).toBe("src/a.ts");
    expect(result.current?.("README.md")).toBe("/repo/README.md");
  });

  it("keeps paths as they are without Git metadata", () => {
    mocks.query.data = { prefix: null, root: null };
    const { result } = renderHook(() => useAgentPathMapper(3));
    expect(result.current?.("src/a.ts")).toBe("src/a.ts");
  });

  it("returns the same mapper until the paths change", () => {
    mocks.query.data = { prefix: "", root: "/repo" };
    const { result, rerender } = renderHook(() => useAgentPathMapper(3));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("defers the lookup while nothing needs sending", () => {
    renderHook(() => useAgentPathMapper(3, false));
    expect(mocks.options.at(-1)?.query.enabled).toBe(false);
  });

  it("reports a failure once with a retry", () => {
    mocks.query.isError = true;
    mocks.query.error = new Error("not a git repository");
    renderHook(() => useAgentPathMapper(3));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    const [title, options] = mocks.toastError.mock.calls[0] as [
      string,
      { duration: number; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Could not resolve the project's Git paths");
    // Sending stays disabled until a retry, so the reason stays on screen.
    expect(options.duration).toBe(Infinity);
    options.action.onClick();
    expect(mocks.query.refetch).toHaveBeenCalledTimes(1);
  });
});
