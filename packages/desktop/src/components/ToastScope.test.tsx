// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import {
  getGetFeatureQueryKey,
  getListActiveFeaturesQueryKey,
  getListProjectsQueryKey,
} from "@/api/generated";
import { scopedToastDescription } from "@/components/ToastScope";
import { queryClient } from "@/lib/queryClient";

const sessions = vi.hoisted(() => ({ current: {} as Record<string, { featureTitle?: string }> }));

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: { getState: () => ({ sessions: sessions.current }) },
}));

vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: ({ projectId }: { projectId: number }) => <i data-testid={`badge-${projectId}`} />,
}));

function feature(id: number, projectId: number, title: string) {
  return { id, project_id: projectId, title };
}

describe("scopedToastDescription", () => {
  beforeEach(() => {
    queryClient.clear();
    sessions.current = {};
    queryClient.setQueryData(getListProjectsQueryKey(), [
      { id: 1, name: "cadencr", path: "/cadencr" },
      { id: 2, name: "landing", path: "/landing" },
    ]);
  });

  it("resolves a conversation's project, badge and title from the cache", () => {
    queryClient.setQueryData(getGetFeatureQueryKey(7), feature(7, 2, "Fix the footer"));
    render(<>{scopedToastDescription({ featureId: 7 }, "Open the output to see why.")}</>);

    expect(screen.getByTestId("badge-2")).toBeTruthy();
    expect(screen.getByText("landing")).toBeTruthy();
    expect(screen.getByText("Fix the footer")).toBeTruthy();
    expect(screen.getByText("Open the output to see why.")).toBeTruthy();
  });

  it("finds a conversation in the sidebar's active list and prefers its live title", () => {
    queryClient.setQueryData(getListActiveFeaturesQueryKey(), [feature(9, 1, "Session 9")]);
    sessions.current = { "ws-feature-9": { featureTitle: "Rename the exporter" } };
    render(<>{scopedToastDescription({ featureId: 9 })}</>);

    expect(screen.getByText("cadencr")).toBeTruthy();
    expect(screen.getByText("Rename the exporter")).toBeTruthy();
    expect(screen.queryByText("Session 9")).toBeNull();
  });

  it("shows only the project when no conversation is given", () => {
    render(<>{scopedToastDescription({ projectId: 1 })}</>);

    expect(screen.getByTestId("badge-1")).toBeTruthy();
    expect(screen.getByText("cadencr")).toBeTruthy();
    expect(screen.queryByText("·")).toBeNull();
  });

  it("keeps the plain description when nothing is cached", () => {
    queryClient.clear();

    expect(scopedToastDescription({ featureId: 7 }, "Pushed.")).toBe("Pushed.");
    expect(scopedToastDescription({ projectId: undefined }, "Body")).toBe("Body");
  });
});
