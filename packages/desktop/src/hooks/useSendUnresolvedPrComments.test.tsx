import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "@/api/generated";

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { useSendUnresolvedPrComments } from "./useSendUnresolvedPrComments";

const THREAD: CommentThread = {
  id: "t1",
  resolved: false,
  outdated: false,
  file: "packages/app/src/a.ts",
  line: 4,
  side: "new",
  comments: [
    {
      author: { username: "alice", display_name: null, avatar_url: null },
      body_markdown: "Handle the empty case.",
      created_at: "2026-07-20T09:00:00Z",
      url: null,
    },
  ],
};

beforeEach(() => {
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

describe("useSendUnresolvedPrComments", () => {
  it("waits for the agent path mapping before sending", () => {
    const onSend = vi.fn();
    const { result } = renderHook(() =>
      useSendUnresolvedPrComments({
        unresolved: [THREAD],
        pr: null,
        toAgentPath: undefined,
        onSend,
      }),
    );
    expect(result.current.disabled).toBe(true);
    act(() => result.current.send());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("names the threads' files the way the agent resolves them", () => {
    const onSend = vi.fn();
    const { result } = renderHook(() =>
      useSendUnresolvedPrComments({
        unresolved: [THREAD],
        pr: null,
        toAgentPath: (path) => path.replace("packages/app/", ""),
        onSend,
      }),
    );
    expect(result.current.disabled).toBe(false);
    act(() => result.current.send());
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining("### src/a.ts:4"));
    expect(onSend).not.toHaveBeenCalledWith(expect.stringContaining("packages/app/"));
  });
});
