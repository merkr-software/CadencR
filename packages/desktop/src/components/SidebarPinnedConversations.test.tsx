import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Feature } from "@/api/generated";

interface MutationOptions {
  mutation: {
    onSuccess: () => void;
    onError: (error: unknown) => void;
  };
}

const mocks = vi.hoisted(() => {
  const navigate = vi.fn();
  const mutate = vi.fn();
  let pinned: Feature[] = [];
  let captured: MutationOptions | null = null;
  return {
    navigate,
    mutate,
    invalidateByUrlPrefix: vi.fn(),
    setPinned: (features: Feature[]) => {
      pinned = features;
    },
    getPinned: (): Feature[] => pinned,
    useUpdateFeaturePinned: vi.fn((opts: MutationOptions) => {
      captured = opts;
      return { mutate };
    }),
    getOptions: (): MutationOptions | null => captured,
  };
});

vi.mock("@/api/generated", () => ({
  useListPinnedFeatures: () => ({ data: mocks.getPinned() }),
  useListProjects: () => ({
    data: [
      { id: 5, name: "Proj Five", path: "/p5" },
      { id: 9, name: "Proj Nine", path: "/p9" },
    ],
  }),
  useUpdateFeaturePinned: mocks.useUpdateFeaturePinned,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/lib/queryClient", () => ({
  invalidateByUrlPrefix: mocks.invalidateByUrlPrefix,
}));

vi.mock("@/lib/feature-focus-handoff", () => ({
  getFocusedTabForFeature: () => undefined,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// Stub the row so this suite stays focused on the section's own behavior
// (fetch → header/empty, navigate, unpin) without wiring every store the row
// reads. The stub surfaces the props the section is responsible for.
vi.mock("@/components/PinnedConversationRow", () => ({
  PinnedConversationRow: ({
    feature,
    onNavigate,
    onUnpin,
  }: {
    feature: Feature;
    onNavigate: (f: Feature) => void;
    onUnpin: (id: number) => void;
  }) => (
    <div>
      <button onClick={() => onNavigate(feature)}>open-{feature.id}</button>
      <button onClick={() => onUnpin(feature.id)}>unpin-{feature.id}</button>
    </div>
  ),
}));

import { SidebarPinnedConversations } from "./SidebarPinnedConversations";

function feature(id: number, projectId: number): Feature {
  return {
    id,
    project_id: projectId,
    title: `Feature ${id}`,
    status: "active",
    type: "ws-session",
    created_at: "2026-01-01T00:00:00Z",
    is_pinned: true,
  } as unknown as Feature;
}

function renderSection(activeFeatureId: number | null = null) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SidebarPinnedConversations activeFeatureId={activeFeatureId} onSelectFeature={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("SidebarPinnedConversations", () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.mutate.mockClear();
    mocks.invalidateByUrlPrefix.mockClear();
    mocks.setPinned([]);
  });

  it("renders nothing when no conversation is pinned", () => {
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a Pinned header with a row per pinned feature across projects", () => {
    mocks.setPinned([feature(1, 5), feature(2, 9)]);
    renderSection();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("open-1")).toBeInTheDocument();
    expect(screen.getByText("open-2")).toBeInTheDocument();
  });

  it("navigates to the conversation using its own project's path", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 9)]);
    renderSection();
    await user.click(screen.getByText("open-1"));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/ws-session/$sessionId",
        search: { cwd: "/p9", featureId: 1, projectId: 9 },
      }),
    );
  });

  it("unpins via the feature pin column and refreshes the feature caches", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 5)]);
    renderSection();
    await user.click(screen.getByText("unpin-1"));
    expect(mocks.mutate).toHaveBeenCalledWith({ id: 1, data: { pinned: false } });

    // onSuccess is the only refresh path — no optimistic mutation.
    mocks.getOptions()?.mutation.onSuccess();
    expect(mocks.invalidateByUrlPrefix).toHaveBeenCalledWith(expect.anything(), "/api/features");
  });
});
