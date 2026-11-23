import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { ProjectFeatures } from "./ProjectFeatures";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { resetPersistedIdSets } from "@/test/persisted-id-set-mock";

/**
 * Opening a conversation must re-render only the two rows whose highlight
 * flips. Every hook result here is stable, as it is in the app between two
 * fetches, so any other row render comes from the list itself.
 */
const mocks = vi.hoisted(() => {
  const feature = (id: number, title: string) => ({
    id,
    title,
    status: "active",
    type: "ws-session",
    project_id: 1,
    is_pinned: false,
    created_at: `2026-01-0${id}T00:00:00Z`,
  });
  const mutation = { mutate: () => {}, mutateAsync: () => Promise.resolve(), isPending: false };
  return {
    navigate: () => Promise.resolve(),
    rowRenders: new Map<number, number>(),
    features: { data: [feature(1, "One"), feature(2, "Two"), feature(3, "Three")] },
    empty: { data: [], error: null },
    mutation,
  };
});

// Stable, like the router's own.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));

vi.mock("@/hooks/usePersistedIdSet", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("@/test/persisted-id-set-mock")),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListFeatures: () => mocks.features,
  useListFeatureWorktrees: () => mocks.empty,
  useListFeatureActivity: () => mocks.empty,
  useListFeaturePorts: () => mocks.empty,
  useGetStats: () => ({ data: undefined }),
  useUpdateFeatureLabel: () => mocks.mutation,
  useUpdateFeatureStatus: () => mocks.mutation,
  useUpdateFeaturePinned: () => mocks.mutation,
  useDeleteFeature: () => mocks.mutation,
  useArchiveFeature: () => mocks.mutation,
}));

// Rendered by every row on each of its renders.
vi.mock("@/components/FeatureRowBody", () => ({
  FeatureRowBody: ({ feature }: { feature: Feature }) => {
    mocks.rowRenders.set(feature.id, (mocks.rowRenders.get(feature.id) ?? 0) + 1);
    return <span>{feature.title}</span>;
  },
}));

const onSelectFeature = vi.fn();

function list(activeFeatureId: number | null) {
  return (
    <ProjectFeatures
      projectId={1}
      projectPath="/repo"
      activeFeatureId={activeFeatureId}
      onSelectFeature={onSelectFeature}
    />
  );
}

describe("ProjectFeatures on a conversation switch", () => {
  beforeEach(() => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, dormantAfter: "never" },
    });
    resetPersistedIdSets();
    mocks.rowRenders.clear();
  });

  it("re-renders only the row that leaves and the row that takes the highlight", () => {
    const view = render(list(1));
    expect([...mocks.rowRenders.keys()].sort()).toEqual([1, 2, 3]);
    mocks.rowRenders.clear();

    view.rerender(list(2));

    expect(Object.fromEntries(mocks.rowRenders)).toEqual({ 1: 1, 2: 1 });
  });
});
