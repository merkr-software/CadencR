import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorMessage, retryUnlessRefusedForSize, toastError } from "./api-errors";

const toastErrorMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

describe("apiErrorMessage", () => {
  it("uses backend JSON error messages from Axios errors", () => {
    const err = {
      isAxiosError: true,
      response: { data: { error: "Bad request: target branch worktree has uncommitted changes" } },
    };

    expect(apiErrorMessage(err, "Fallback")).toBe(
      "Bad request: target branch worktree has uncommitted changes",
    );
  });

  it("falls back to Error messages when there is no backend JSON error", () => {
    expect(apiErrorMessage(new Error("network down"), "Fallback")).toBe("network down");
  });

  it("uses the fallback when no useful message is available", () => {
    expect(apiErrorMessage({ isAxiosError: true, response: { data: {} } }, "Fallback")).toBe(
      "Fallback",
    );
  });
});

describe("toastError", () => {
  beforeEach(() => toastErrorMock.mockReset());

  it("surfaces the resolved backend message as a toast", () => {
    toastError(
      { isAxiosError: true, response: { data: { error: "worktree has uncommitted changes" } } },
      "Fallback",
    );

    expect(toastErrorMock).toHaveBeenCalledWith("worktree has uncommitted changes");
  });

  it("surfaces the fallback when the error carries no useful message", () => {
    toastError({}, "Something went wrong");

    expect(toastErrorMock).toHaveBeenCalledWith("Something went wrong");
  });
});

describe("retryUnlessRefusedForSize", () => {
  const refused = (code: string) => ({
    isAxiosError: true,
    response: { status: 413, data: { error: "too large", code } },
  });

  it("retries other failures once, like the app default", () => {
    expect(retryUnlessRefusedForSize(0, new Error("network down"))).toBe(true);
    expect(retryUnlessRefusedForSize(0, refused("INTERNAL_ERROR"))).toBe(true);
    expect(retryUnlessRefusedForSize(1, refused("INTERNAL_ERROR"))).toBe(false);
  });

  it("never retries a diff or file refused for its size", () => {
    expect(retryUnlessRefusedForSize(0, refused("DIFF_TOO_LARGE"))).toBe(false);
    expect(retryUnlessRefusedForSize(0, refused("FILE_TOO_LARGE"))).toBe(false);
  });
});
