import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface MutationOptions {
  mutation: {
    onSuccess: (data: unknown, variables: { id: number; data: { pinned: boolean } }) => void;
    onError: (error: unknown) => void;
  };
}

const mocks = vi.hoisted(() => {
  const mutate = vi.fn();
  let captured: MutationOptions | null = null;
  const useUpdateFeaturePinned = vi.fn((opts: MutationOptions) => {
    captured = opts;
    return { mutate, isPending: false };
  });
  return { mutate, useUpdateFeaturePinned, getOptions: (): MutationOptions | null => captured };
});

vi.mock("@/api/generated", () => ({
  useUpdateFeaturePinned: mocks.useUpdateFeaturePinned,
  getGetUnifiedAgentsQueryKey: () => ["/api/agents/unified"] as const,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { useUnifiedAgentPinControls } from "./useUnifiedAgentPinControls";
import type { UnifiedAgentEntry, UnifiedAgentsResponse } from "@/api/generated";

const QUERY_KEY = ["/api/agents/unified"] as const;

// Minimal stand-ins — the hook only reads `feature.id`, `session.sessionDbId`
// and `is_pinned`.
function entry(featureId: number, sessionDbId: number, isPinned: boolean): UnifiedAgentEntry {
  return {
    feature: { id: featureId },
    session: { sessionDbId },
    is_pinned: isPinned,
  } as unknown as UnifiedAgentEntry;
}

function makeClient(agents: UnifiedAgentEntry[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData<UnifiedAgentsResponse>(QUERY_KEY, { agents });
  return client;
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useUnifiedAgentPinControls", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.useUpdateFeaturePinned.mockClear();
  });

  it("pins the whole feature, not the individual session", () => {
    const client = makeClient([entry(5, 1, false)]);
    const { result } = renderHook(() => useUnifiedAgentPinControls(entry(5, 1, false)), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current.toggle());

    expect(mocks.mutate).toHaveBeenCalledWith({ id: 5, data: { pinned: true } }, expect.anything());
  });

  it("unpins a pinned feature", () => {
    const client = makeClient([entry(5, 1, true)]);
    const { result } = renderHook(() => useUnifiedAgentPinControls(entry(5, 1, true)), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current.toggle());

    expect(mocks.mutate).toHaveBeenCalledWith(
      { id: 5, data: { pinned: false } },
      expect.anything(),
    );
  });

  it("on success flips is_pinned for every card of that feature, leaving others", () => {
    // Feature 5 has two cards in the grid; feature 9 has one.
    const client = makeClient([entry(5, 1, false), entry(5, 2, false), entry(9, 3, false)]);
    renderHook(() => useUnifiedAgentPinControls(entry(5, 1, false)), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      mocks.getOptions()?.mutation.onSuccess(undefined, { id: 5, data: { pinned: true } });
    });

    const data = client.getQueryData<UnifiedAgentsResponse>(QUERY_KEY);
    const feature5 = data?.agents.filter((a) => a.feature.id === 5) ?? [];
    expect(feature5).toHaveLength(2);
    expect(feature5.every((a) => a.is_pinned)).toBe(true);
    expect(data?.agents.find((a) => a.feature.id === 9)?.is_pinned).toBe(false);
  });
});
