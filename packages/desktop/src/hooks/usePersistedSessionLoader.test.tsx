import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient, renderHook, waitFor } from "@/test-utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";
import { usePersistedSessionLoader } from "./usePersistedSessionLoader";

const mocks = vi.hoisted(() => ({
  owed: new Set<string>(),
  refresh: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/conversation-preload", () => ({
  CONVERSATION_SNAPSHOT_PARAMS: { limit: 40 },
  takeSnapshotHydration: (sessionId: string) => mocks.owed.delete(sessionId),
}));
vi.mock("@/lib/api-errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-errors")>()),
  toastError: mocks.toastError,
}));

const SESSION_ID = "ws-feature-5";

/** A session hydrated from a snapshot: history settled, socket not bound yet. */
function hydrated(patch: Partial<SessionEntry> = {}): SessionEntry {
  return { ...createSessionEntry(), persistedLoaded: true, ...patch };
}

function renderLoader(strict = false) {
  const client = createTestQueryClient();
  return renderHook(
    ({ session }: { session: SessionEntry }) =>
      usePersistedSessionLoader(session, SESSION_ID, 5, undefined),
    {
      initialProps: { session: hydrated() },
      reactStrictMode: strict,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

describe("catch-up of a conversation opened from a preloaded snapshot", () => {
  beforeEach(() => {
    mocks.owed.clear();
    mocks.owed.add(SESSION_ID);
    mocks.refresh.mockReset();
    mocks.refresh.mockResolvedValue(undefined);
    mocks.toastError.mockClear();
    useWsSessionStore.setState({ refreshSessionMessages: mocks.refresh });
  });

  afterEach(() => useWsSessionStore.setState({ sessions: {} }));

  it("waits for the session to be bound, then runs once", () => {
    const view = renderLoader();
    expect(mocks.refresh).not.toHaveBeenCalled();

    view.rerender({ session: hydrated({ serverSessionId: "server-1" }) });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith(SESSION_ID);

    // A rebinding later is the stream's own business.
    view.rerender({ session: hydrated({ serverSessionId: "server-2" }) });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("runs once under StrictMode's double effects", () => {
    const view = renderLoader(true);

    view.rerender({ session: hydrated({ serverSessionId: "server-1" }) });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not run for a session that owes none", () => {
    mocks.owed.clear();
    const view = renderLoader();

    view.rerender({ session: hydrated({ serverSessionId: "server-1" }) });

    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("says so when it fails", async () => {
    const failure = new Error("socket closed");
    mocks.refresh.mockRejectedValue(failure);
    const view = renderLoader();

    view.rerender({ session: hydrated({ serverSessionId: "server-1" }) });

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(failure, "Could not refresh this conversation"),
    );
  });
});
