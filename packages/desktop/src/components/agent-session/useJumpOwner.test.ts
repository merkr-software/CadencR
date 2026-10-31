// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@/test-utils";
import { useJumpOwner } from "./useAgentSessionScroll";

describe("useJumpOwner", () => {
  it("hands over the viewport, then cancels the jump still settling before the next starts", () => {
    const calls: string[] = [];
    const prepare = vi.fn(() => calls.push("prepare"));
    const { result } = renderHook(() => useJumpOwner(prepare));
    const first = vi.fn(() => calls.push("cancel first"));
    result.current(() => {
      calls.push("start first");
      return first;
    });
    result.current(() => {
      calls.push("start second");
      return () => {};
    });
    expect(calls).toEqual(["prepare", "start first", "prepare", "cancel first", "start second"]);
  });

  it("returns the jump's cancel, and stops the jump when the session unmounts", () => {
    const { result, unmount } = renderHook(() => useJumpOwner(() => {}));
    const cancel = vi.fn();
    expect(result.current(() => cancel)).toBe(cancel);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
