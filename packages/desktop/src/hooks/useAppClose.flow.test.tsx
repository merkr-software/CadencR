import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveCloseWork } from "@/api/generated";
import type { AppCloseRequest } from "@/shared/app-close";
import { useAppClose } from "./useAppClose";

const mock = vi.hoisted(() => ({
  receive: { current: undefined as ((request: AppCloseRequest) => void) | undefined },
  list: vi.fn<() => Promise<ActiveCloseWork[]>>(),
  confirm: vi.fn(async () => {}),
  acknowledge: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  error: vi.fn(),
}));

vi.mock("@/api/generated", () => ({ getActiveCloseWork: mock.list }));
vi.mock("@/hooks/useShortcut", () => ({ useGlobalShortcutById: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: mock.error, loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: {
    confirmClose: mock.confirm,
    acknowledgeCloseRequest: mock.acknowledge,
    cancelClose: mock.cancel,
    onCloseRequested: (cb: (request: AppCloseRequest) => void) => {
      mock.receive.current = cb;
      return () => {
        mock.receive.current = undefined;
      };
    },
  },
}));

const QUIT = { id: 1, quitting: true };
const BACKGROUND: ActiveCloseWork = {
  session_id: 9,
  feature_id: 4,
  label: "Unopened conversation",
  label_uses_fallback: false,
  waiting_on_you: false,
  background_only: true,
};

function ask(request = QUIT) {
  act(() => mock.receive.current?.(request));
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.list.mockReset();
});

describe("useAppClose", () => {
  it("confirms without asking when the service lists no work", async () => {
    mock.list.mockResolvedValue([]);
    const { result } = renderHook(() => useAppClose(null));
    ask();

    await waitFor(() => expect(mock.confirm).toHaveBeenCalledWith(QUIT.id));
    expect(result.current.request).toBeNull();
    expect(mock.acknowledge).not.toHaveBeenCalled();
  });

  it("asks about a conversation with background work even when no conversation is open", async () => {
    mock.list.mockResolvedValue([BACKGROUND]);
    const { result } = renderHook(() => useAppClose(null));
    ask();

    await waitFor(() => expect(result.current.request).toEqual(QUIT));
    expect(result.current.agents).toEqual([BACKGROUND]);
    expect(mock.acknowledge).toHaveBeenCalledWith(QUIT.id);

    act(result.current.cancel);
    expect(result.current.request).toBeNull();
    expect(mock.cancel).toHaveBeenCalledWith(QUIT.id);
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it("uses the matching request id when the user confirms after a failed lookup", async () => {
    mock.list.mockRejectedValue(new Error("Service unavailable"));
    const { result } = renderHook(() => useAppClose(null));
    ask();

    await waitFor(() => expect(result.current.request).toEqual(QUIT));
    expect(result.current.agents).toBeNull();
    act(result.current.close);
    expect(mock.confirm).toHaveBeenCalledExactlyOnceWith(QUIT.id);
  });

  it("discards a late work lookup when quitting replaces a window close", async () => {
    const lookup = Promise.withResolvers<ActiveCloseWork[]>();
    mock.list.mockReturnValueOnce(lookup.promise).mockResolvedValueOnce([BACKGROUND]);
    const { result } = renderHook(() => useAppClose(null));

    ask({ id: 1, quitting: false });
    const quit = { id: 2, quitting: true };
    ask(quit);
    await waitFor(() => expect(result.current.request).toEqual(quit));
    await act(async () => lookup.resolve([]));

    expect(result.current.request).toEqual(quit);
    expect(mock.confirm).not.toHaveBeenCalled();
  });
});
