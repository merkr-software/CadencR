import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@/test-utils";
import {
  getListFeatureWorktreesQueryKey,
  getListFeaturesQueryKey,
  type Feature,
} from "@/api/generated";
import { FilteredProjectList } from "./FilteredProjectList";

vi.mock("@/hooks/useLiveFeatureMeta", () => ({
  useLiveFeatureMeta: () => ({
    "ws-session-3": { featureTitle: "Renamed live", isAutoNaming: false },
  }),
}));
vi.mock("@/lib/ws-session-id", () => ({
  wsSessionIdFromFeature: (id: number) => `ws-session-${id}`,
}));

const projects = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Beta" },
  { id: 3, name: "Gamma" },
];

function feature(id: number, projectId: number, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    project_id: projectId,
    title: `Conversation ${id}`,
    status: "active",
    type: "ws-session",
    is_pinned: false,
    created_at: "2026-01-01 00:00:00",
    ...overrides,
  } as Feature;
}

function seededClient(lists: Record<number, Feature[]>): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const project of projects) {
    client.setQueryData(
      getListFeaturesQueryKey({ project_id: project.id, include_archived: true }),
      lists[project.id] ?? [],
    );
    client.setQueryData(getListFeatureWorktreesQueryKey({ project_id: project.id }), [
      {
        feature_id: 7,
        worktree_path: "/w",
        worktree_branch: "fix/ci",
        directory_exists: true,
        is_default_branch: false,
        is_main_worktree: false,
        live: true,
      },
    ]);
  }
  return client;
}

function renderList(query: string, lists: Record<number, Feature[]>) {
  return render(
    <FilteredProjectList
      projects={projects}
      query={query}
      renderProject={(project, match) => (
        <div key={project.id} data-testid={`project-${project.id}`}>
          {match === null ? "all" : [...match].join(",")}
        </div>
      )}
    />,
    { queryClient: seededClient(lists) },
  );
}

describe("FilteredProjectList", () => {
  it("keeps a project whole when its name matches, else just its matching rows", () => {
    renderList("beta", { 1: [feature(1, 1, { title: "Beta rollout" }), feature(2, 1)] });
    expect(screen.getByTestId("project-1")).toHaveTextContent("1");
    expect(screen.getByTestId("project-2")).toHaveTextContent("all");
    expect(screen.queryByTestId("project-3")).not.toBeInTheDocument();
  });

  it("matches live titles, labels and branches, never pinned or archived rows", () => {
    renderList("renamed", {
      3: [feature(3, 3), feature(4, 3, { title: "Renamed too", is_pinned: true })],
    });
    expect(screen.getByTestId("project-3")).toHaveTextContent(/^3$/);

    renderList("fix/ci", {
      1: [feature(7, 1)],
      2: [feature(8, 2, { status: "archived", label: "fix/ci" })],
    });
    expect(screen.getByTestId("project-1")).toHaveTextContent("7");
    expect(screen.queryByTestId("project-2")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    renderList("zzz", {});
    expect(screen.getByText("No conversation matches “zzz”")).toBeInTheDocument();
  });
});
