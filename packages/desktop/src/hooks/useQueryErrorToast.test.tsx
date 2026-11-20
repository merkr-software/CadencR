import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, dismiss: mocks.dismiss } }));

const { useQueryErrorToast } = await import("./useQueryErrorToast");

afterEach(() => {
  vi.clearAllMocks();
});

describe("useQueryErrorToast", () => {
  it("toasts a failed query once under its id, then dismisses it on recovery", () => {
    const failed: { isError: boolean; error: unknown } = {
      isError: true,
      error: new Error("git ls-files failed"),
    };
    const { rerender } = renderHook(
      ({ query }) => useQueryErrorToast(query, "Git blame unavailable", "blame:1:a.ts"),
      { initialProps: { query: failed } },
    );
    expect(mocks.error).toHaveBeenCalledWith("Git blame unavailable: git ls-files failed", {
      id: "blame:1:a.ts",
    });

    rerender({ query: { isError: true, error: new Error("git ls-files failed") } });
    expect(mocks.error).toHaveBeenCalledTimes(1);

    rerender({ query: { isError: false, error: null } });
    expect(mocks.dismiss).toHaveBeenCalledWith("blame:1:a.ts");
  });

  it("never touches the toaster for a query that has not failed", () => {
    const { unmount } = renderHook(() =>
      useQueryErrorToast({ isError: false, error: null }, "Git blame unavailable", "blame:1:b.ts"),
    );
    unmount();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
