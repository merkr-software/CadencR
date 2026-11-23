import { act, renderHook } from "@testing-library/react";
import { AxiosError, type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LARGE_DIFF_BYTES } from "@/lib/diff-thresholds";
import * as parseModule from "@/lib/parse-unified-diff";

const mocks = vi.hoisted(() => ({
  useGetFileDiff: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useGetFileDiff: mocks.useGetFileDiff,
}));

import { useFileDiffSection } from "./useFileDiffSection";

const baseParams = {
  featureId: 1,
  filePath: "src/huge.min.js",
  mode: "worktree" as const,
  commitSha: null,
  enabled: true,
};

describe("useFileDiffSection", () => {
  beforeEach(() => {
    mocks.useGetFileDiff.mockReset();
    vi.restoreAllMocks();
  });

  it("skips parseUnifiedDiff when raw diff exceeds LARGE_DIFF_BYTES and allowLargeParse is false", () => {
    const hugeLine = "x".repeat(LARGE_DIFF_BYTES + 1024);
    const raw = `diff --git a/src/huge.min.js b/src/huge.min.js\n--- a/src/huge.min.js\n+++ b/src/huge.min.js\n@@ -0,0 +1 @@\n+${hugeLine}\n`;
    mocks.useGetFileDiff.mockReturnValue({
      data: { diff: raw },
      isLoading: false,
      isError: false,
      error: null,
    });
    const parseSpy = vi.spyOn(parseModule, "parseUnifiedDiff");

    const { result, rerender } = renderHook(
      ({ allowLargeParse }) => useFileDiffSection({ ...baseParams, allowLargeParse }),
      { initialProps: { allowLargeParse: false } },
    );

    expect(parseSpy).not.toHaveBeenCalled();
    expect(result.current.isDeferredLarge).toBe(true);
    expect(result.current.section).toBeNull();
    expect(result.current.rawLength).toBe(raw.length);

    // Once the user opts in via "Display diff", parseUnifiedDiff executes.
    rerender({ allowLargeParse: true });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isDeferredLarge).toBe(false);
    expect(result.current.section?.newFileName).toBe("src/huge.min.js");
  });

  it("parses normal small diffs immediately", () => {
    const raw = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    mocks.useGetFileDiff.mockReturnValue({
      data: { diff: raw },
      isLoading: false,
      isError: false,
      error: null,
    });

    const { result } = renderHook(() =>
      useFileDiffSection({ ...baseParams, filePath: "src/a.ts" }),
    );
    expect(result.current.isDeferredLarge).toBe(false);
    expect(result.current.section?.newFileName).toBe("src/a.ts");
  });

  it("does not defer binary patches as large text diffs", () => {
    const raw = `diff --git a/blob.bin b/blob.bin\nGIT binary patch\n${"a".repeat(LARGE_DIFF_BYTES)}\n`;
    mocks.useGetFileDiff.mockReturnValue({
      data: { diff: raw },
      isLoading: false,
      isError: false,
      error: null,
    });

    const { result } = renderHook(() =>
      useFileDiffSection({ ...baseParams, filePath: "blob.bin", allowLargeParse: false }),
    );
    expect(result.current.isDeferredLarge).toBe(false);
    expect(result.current.section).not.toBeNull();
  });

  it("resets opt-in before parseUnifiedDiff runs when a newly-huge revision arrives", () => {
    const hugeV1 = `diff --git a/src/huge.min.js b/src/huge.min.js\n--- a/src/huge.min.js\n+++ b/src/huge.min.js\n@@ -0,0 +1 @@\n+${"a".repeat(LARGE_DIFF_BYTES + 1024)}\n`;
    const hugeV2 = `diff --git a/src/huge.min.js b/src/huge.min.js\n--- a/src/huge.min.js\n+++ b/src/huge.min.js\n@@ -0,0 +1 @@\n+${"b".repeat(LARGE_DIFF_BYTES + 2048)}\n`;
    let currentDiff = hugeV1;
    mocks.useGetFileDiff.mockImplementation(() => ({
      data: { diff: currentDiff },
      isLoading: false,
      isError: false,
      error: null,
    }));
    const parseSpy = vi.spyOn(parseModule, "parseUnifiedDiff");

    const { result, rerender } = renderHook(() => useFileDiffSection(baseParams));
    expect(result.current.isDeferredLarge).toBe(true);
    expect(parseSpy).not.toHaveBeenCalled();

    // User opts in to hugeV1.
    act(() => result.current.displayLargeDiff());
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isDeferredLarge).toBe(false);
    expect(result.current.section?.newFileName).toBe("src/huge.min.js");

    // A brand-new multi-MB revision arrives: opt-in must reset BEFORE parseUnifiedDiff runs.
    currentDiff = hugeV2;
    rerender();
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isDeferredLarge).toBe(true);
    expect(result.current.section).toBeNull();
    expect(result.current.rawLength).toBe(hugeV2.length);
  });

  it("keeps opt-in across async large-by-lines fetch, then resets on a subsequent revision", () => {
    const bigV1 = `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -0,0 +1 @@\n+${"a".repeat(LARGE_DIFF_BYTES + 512)}\n`;
    const bigV2 = `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -0,0 +1 @@\n+${"b".repeat(LARGE_DIFF_BYTES + 512)}\n`;
    let queryState: {
      data: { diff: string } | undefined;
      isLoading: boolean;
      isError: boolean;
      error: null;
    } = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    mocks.useGetFileDiff.mockImplementation((_params, opts) =>
      opts?.query?.enabled
        ? queryState
        : { data: undefined, isLoading: false, isError: false, error: null },
    );
    const parseSpy = vi.spyOn(parseModule, "parseUnifiedDiff");

    const { result, rerender } = renderHook(() =>
      useFileDiffSection({ ...baseParams, filePath: "src/big.ts", isLargeByLines: true }),
    );
    expect(result.current.isDeferredLarge).toBe(true);
    expect(mocks.useGetFileDiff).toHaveBeenLastCalledWith(expect.anything(), {
      query: expect.objectContaining({ enabled: false }),
    });

    // User clicks "Display diff" while fetch has not completed yet.
    queryState = { data: undefined, isLoading: true, isError: false, error: null };
    act(() => result.current.displayLargeDiff());
    expect(result.current.isDeferredLarge).toBe(false);
    expect(result.current.isLoading).toBe(true);
    expect(mocks.useGetFileDiff).toHaveBeenLastCalledWith(expect.anything(), {
      query: expect.objectContaining({ enabled: true }),
    });

    // Initial fetch finishes -> parses bigV1 once.
    queryState = { data: { diff: bigV1 }, isLoading: false, isError: false, error: null };
    rerender();
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isDeferredLarge).toBe(false);
    expect(result.current.section?.newFileName).toBe("src/big.ts");

    // Refetch delivers bigV2 -> resets to deferred placeholder without calling parseUnifiedDiff.
    queryState = { data: { diff: bigV2 }, isLoading: false, isError: false, error: null };
    rerender();
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isDeferredLarge).toBe(true);
    expect(result.current.section).toBeNull();
  });

  it("retries a failed fetch once, but never a diff refused for its size", () => {
    mocks.useGetFileDiff.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: null,
    });
    renderHook(() => useFileDiffSection(baseParams));
    const options = mocks.useGetFileDiff.mock.calls[0]?.[1] as {
      query: { retry: (failureCount: number, error: unknown) => boolean };
    };
    const failure = (status: number, code: string): AxiosError =>
      new AxiosError("failed", "ERR_BAD_RESPONSE", undefined, undefined, {
        status,
        data: { error: "refused", code },
      } as AxiosResponse);

    expect(options.query.retry(0, failure(500, "INTERNAL_ERROR"))).toBe(true);
    expect(options.query.retry(1, failure(500, "INTERNAL_ERROR"))).toBe(false);
    expect(options.query.retry(0, new Error("network"))).toBe(true);
    expect(options.query.retry(0, failure(413, "DIFF_TOO_LARGE"))).toBe(false);
    expect(options.query.retry(0, failure(413, "FILE_TOO_LARGE"))).toBe(false);
  });
});
