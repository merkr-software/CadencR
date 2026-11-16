import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePushOutputStore } from "@/stores/usePushOutputStore";
import { usePushSubmission } from "./usePushSubmission";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  PushForceMode: { none: "none", force: "force", "force-with-lease": "force-with-lease" },
  usePush: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));

vi.mock("@/components/ToastScope", () => ({
  scopedToastDescription: (scope: unknown, description?: unknown) => ({ scope, description }),
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

beforeEach(() => {
  mocks.mutateAsync.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  usePushOutputStore.setState({ byFeature: {} });
});

describe("usePushSubmission", () => {
  it("keeps one controller when background progress is reopened", async () => {
    let resolvePush: ((value: { success: boolean; error: string | null }) => void) | undefined;
    mocks.mutateAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePush = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }) => usePushSubmission({ featureId: 11, open, onOpenChange }),
      { initialProps: { open: true } },
    );

    void result.current.submit("force-with-lease");
    act(() => result.current.onDialogOpenChange(false));
    rerender({ open: false });
    rerender({ open: true });
    resolvePush?.({ success: true, error: null });

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Pushed"));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      data: { feature_id: 11, force: "force-with-lease" },
    });
  });

  it("leaves whatever dialog is open alone when a backgrounded push finishes", async () => {
    // There is one `activeDialog` slot: closing on behalf of a run the user
    // already backgrounded would slam shut the dialog they opened since.
    mocks.mutateAsync.mockResolvedValueOnce({ success: true, error: null });
    const onOpenChange = vi.fn();
    const { result } = renderHook(() =>
      usePushSubmission({ featureId: 11, open: false, onOpenChange }),
    );

    await act(() => result.current.submit("none"));

    expect(mocks.toastSuccess).toHaveBeenCalledWith("Background push completed", {
      description: { scope: { featureId: 11 } },
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("drops a finished run so the next open starts empty", async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ success: true, error: null });
    const { result } = renderHook(() =>
      usePushSubmission({ featureId: 11, open: true, onOpenChange: vi.fn() }),
    );

    act(() => result.current.setForce("force"));
    await act(() => result.current.submit("force"));

    expect(usePushOutputStore.getState().byFeature[11]).toBeUndefined();
    // …and from the safe default, not the force mode that just succeeded.
    expect(result.current.force).toBe("none");
  });

  it("refuses to start a second push while one is running", async () => {
    mocks.mutateAsync.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      usePushSubmission({ featureId: 11, open: true, onOpenChange: vi.fn() }),
    );

    void result.current.submit("none");
    await waitFor(() => expect(usePushOutputStore.getState().byFeature[11]).toBeDefined());
    await act(() => result.current.submit("force"));

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps a background failure discoverable from its toast", async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ success: false, error: "non-fast-forward" });
    const onOpenChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }) => usePushSubmission({ featureId: 11, open, onOpenChange }),
      { initialProps: { open: true } },
    );

    act(() => result.current.onDialogOpenChange(false));
    rerender({ open: false });
    await act(() => result.current.submit("none"));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Push failed",
      expect.objectContaining({ action: expect.objectContaining({ label: "View output" }) }),
    );
    expect(usePushOutputStore.getState().byFeature[11]).toMatchObject({
      status: "error",
      output: expect.stringContaining("non-fast-forward"),
    });
  });

  it("dismisses a viewed failure when the dialog closes", () => {
    const store = usePushOutputStore.getState();
    store.start(11);
    store.fail(11, "rejected");
    const { result } = renderHook(() =>
      usePushSubmission({ featureId: 11, open: true, onOpenChange: vi.fn() }),
    );

    act(() => result.current.onDialogOpenChange(false));

    expect(usePushOutputStore.getState().byFeature[11]).toBeUndefined();
  });

  it("re-arms the ssh prompt for a retry", async () => {
    mocks.mutateAsync.mockResolvedValueOnce({ success: false, error: "denied" });
    const { result } = renderHook(() =>
      usePushSubmission({ featureId: 11, open: true, onOpenChange: vi.fn() }),
    );

    act(() => result.current.markPromptAnswered(120));
    expect(result.current.answeredOffset).toBe(120);

    await act(() => result.current.submit("none"));
    expect(result.current.answeredOffset).toBe(-1);
  });
});
