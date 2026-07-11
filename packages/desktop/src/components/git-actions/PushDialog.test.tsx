/**
 * PushDialog test suite.
 *
 * Focuses on the SSH-prompt retry path:
 *
 *   - When `usePushInput().mutateAsync` rejects, the prompt input must STAY
 *     visible with the typed value preserved (the user has to be able to
 *     retry without retyping a passphrase). A toast surfaces the failure.
 *
 *   - When the second submit succeeds, the input disappears.
 *
 * Mock strategy mirrors `CommitDialog.test.tsx`: hoisted `vi.fn` mocks for
 * the orval hooks so each test can choose its own `mutateAsync` behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { usePushOutputStore } from "@/stores/usePushOutputStore";

const mocks = vi.hoisted(() => {
  const pushMutateAsync = vi.fn();
  const pushInputMutateAsync = vi.fn();
  const pushResult = { mutateAsync: pushMutateAsync, isPending: false };
  // We toggle `isPending` per test by mutating this object before render.
  const pushInputResult = { mutateAsync: pushInputMutateAsync, isPending: false };
  const usePushMock = vi.fn(() => pushResult);
  const usePushInputMock = vi.fn(() => pushInputResult);
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  return {
    pushMutateAsync,
    pushInputMutateAsync,
    pushInputResult,
    pushResult,
    usePushMock,
    usePushInputMock,
    toastSuccess,
    toastError,
  };
});

vi.mock("@/api/generated", () => ({
  usePush: mocks.usePushMock,
  usePushInput: mocks.usePushInputMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import PushDialog from "./PushDialog";

beforeEach(() => {
  mocks.pushMutateAsync.mockReset();
  mocks.pushInputMutateAsync.mockReset();
  mocks.pushInputResult.isPending = false;
  mocks.pushResult.isPending = false;
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  // Wipe the streaming buffer between tests so seeded prompts don't leak.
  usePushOutputStore.setState({ byFeature: {} });
});

/**
 * Seed the streaming store as if the backend had already streamed an
 * `Enter passphrase for key '/x'` prompt — which is what triggers
 * `detectSshPrompt` to render the input form.
 */
function seedPrompt(featureId: number): void {
  const store = usePushOutputStore.getState();
  store.start(featureId);
  store.append(featureId, "Enter passphrase for key '/home/u/.ssh/id_ed25519':");
}

describe("PushDialog SSH prompt retry", () => {
  it("keeps the prompt input visible with the typed value when sendInput throws, then submits successfully on retry", async () => {
    // The push itself never resolves during the test — it stays "running"
    // while we exercise the prompt submit path. Avoid an unhandled promise
    // rejection on test teardown by giving the unresolved push a noop
    // catch-equivalent (vitest cancels the promise on teardown anyway).
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    // First call rejects (network drop), second call succeeds.
    mocks.pushInputMutateAsync
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);

    const onOpenChange = vi.fn();
    const { user } = render(<PushDialog featureId={42} open={true} onOpenChange={onOpenChange} />);

    // The dialog auto-starts the push on open; seed the prompt buffer
    // afterwards so `detectSshPrompt` flips the form on.
    seedPrompt(42);

    // Wait for the prompt input to appear (the buffer change triggers a
    // re-render via the zustand selector).
    const input = (await screen.findByLabelText(/Enter passphrase for key/)) as HTMLInputElement;
    await user.type(input, "hunter2");
    await user.click(screen.getByRole("button", { name: /Send/i }));

    // After the first (failed) submit:
    //   - toast.error was called
    //   - input is still visible
    //   - typed value is preserved
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
    const stillThere = (await screen.findByLabelText(
      /Enter passphrase for key/,
    )) as HTMLInputElement;
    expect(stillThere).toBeInTheDocument();
    expect(stillThere.value).toBe("hunter2");

    // Retry — second click resolves. Input + value should now clear.
    await user.click(screen.getByRole("button", { name: /Send/i }));

    await waitFor(() => {
      expect(mocks.pushInputMutateAsync).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/Enter passphrase for key/)).not.toBeInTheDocument();
    });
  });

  it("clears the input on a successful first submit", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    mocks.pushInputMutateAsync.mockResolvedValueOnce(undefined);

    const { user } = render(<PushDialog featureId={9} open={true} onOpenChange={vi.fn()} />);
    seedPrompt(9);

    const input = (await screen.findByLabelText(/Enter passphrase for key/)) as HTMLInputElement;
    await user.type(input, "secret");
    await user.click(screen.getByRole("button", { name: /Send/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText(/Enter passphrase for key/)).not.toBeInTheDocument();
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("fires exactly one toast.error per failed prompt submission", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    mocks.pushInputMutateAsync.mockRejectedValueOnce(new Error("boom"));

    const { user } = render(<PushDialog featureId={11} open={true} onOpenChange={vi.fn()} />);
    seedPrompt(11);

    const input = (await screen.findByLabelText(/Enter passphrase for key/)) as HTMLInputElement;
    await user.type(input, "abc");
    await user.click(screen.getByRole("button", { name: /Send/i }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
    // Give any spurious second call a tick to land before asserting the
    // total stayed at 1. Using a microtask flush is enough — the dialog
    // never schedules a deferred retry.
    await Promise.resolve();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });
});

describe("PushDialog auto-start", () => {
  it("calls the push mutation exactly once when first mounted with open=true", () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    render(<PushDialog featureId={1} open={true} onOpenChange={vi.fn()} />);
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.pushMutateAsync).toHaveBeenCalledWith({
      data: { feature_id: 1 },
    });
  });

  it("re-fires the push when open toggles false then back to true", () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <PushDialog featureId={2} open={true} onOpenChange={onOpenChange} />,
    );
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(1);

    // Close — the cleanup effect must reset `pushStartedRef` so the next
    // open is a real fresh run, not a no-op.
    rerender(<PushDialog featureId={2} open={false} onOpenChange={onOpenChange} />);
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(1);

    // Reopen — fires a second push.
    rerender(<PushDialog featureId={2} open={true} onOpenChange={onOpenChange} />);
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(2);
  });

  it("does not fire a second push when re-rendered with the same open=true (StrictMode-safe)", () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <PushDialog featureId={3} open={true} onOpenChange={onOpenChange} />,
    );
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(1);

    // A re-render with identical props (e.g. parent state change) must
    // NOT trigger another push — `pushStartedRef` guards against the
    // StrictMode double-mount + parent-driven re-renders.
    rerender(<PushDialog featureId={3} open={true} onOpenChange={onOpenChange} />);
    rerender(<PushDialog featureId={3} open={true} onOpenChange={onOpenChange} />);
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("PushDialog success", () => {
  it("closes after push succeeds and leaves git refresh to the WS status event", async () => {
    mocks.pushMutateAsync.mockResolvedValue({ success: true });

    const onOpenChange = vi.fn();
    render(<PushDialog featureId={7} open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Pushed");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
