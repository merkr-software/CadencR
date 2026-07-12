import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitBody } from "@/api/generated";
import { useCommitOutputStore } from "@/stores/useCommitOutputStore";
import { useCommitSubmission } from "./useCommitSubmission";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useCommit: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const BODY: CommitBody = {
  feature_id: 11,
  message: "feat: persistent controller",
  file_paths: ["src/a.ts"],
};

beforeEach(() => {
  mocks.mutateAsync.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  useCommitOutputStore.setState({ byFeature: {} });
});

describe("useCommitSubmission", () => {
  it("keeps one controller when background progress is reopened", async () => {
    let resolveCommit: ((value: { success: boolean; error: string | null }) => void) | undefined;
    mocks.mutateAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCommit = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }) => useCommitSubmission({ featureId: 11, open, onOpenChange }),
      { initialProps: { open: true } },
    );

    void result.current.submit(BODY);
    act(() => result.current.onDialogOpenChange(false));
    rerender({ open: false });
    rerender({ open: true });
    resolveCommit?.({ success: true, error: null });

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Committed"));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps a background failure discoverable from its toast", async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ success: false, error: "lint failed" });
    const onOpenChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }) => useCommitSubmission({ featureId: 11, open, onOpenChange }),
      { initialProps: { open: true } },
    );

    act(() => result.current.onDialogOpenChange(false));
    rerender({ open: false });
    await act(() => result.current.submit(BODY));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Commit failed",
      expect.objectContaining({ action: expect.objectContaining({ label: "View output" }) }),
    );
    expect(useCommitOutputStore.getState().byFeature[11]).toMatchObject({
      status: "error",
      output: expect.stringContaining("lint failed"),
    });
  });

  it("dismisses a viewed failure when the dialog closes", () => {
    const store = useCommitOutputStore.getState();
    store.start(11);
    store.fail(11, "hook failed");
    const onOpenChange = vi.fn();
    const { result } = renderHook(() =>
      useCommitSubmission({ featureId: 11, open: true, onOpenChange }),
    );

    act(() => result.current.onDialogOpenChange(false));

    expect(useCommitOutputStore.getState().byFeature[11]).toBeUndefined();
  });
});
