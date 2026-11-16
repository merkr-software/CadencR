import { describe, expect, it } from "vitest";
import type { Feature, Project } from "@/api/generated";
import { applyOrder } from "@/lib/frozen-order";
import { orderProjects } from "./useOrderedProjects";

function project(id: number): Project {
  return { id, name: `p${id}`, path: `/p${id}` } as Project;
}

function ids(projects: readonly { id: number }[]): number[] {
  return projects.map((p) => p.id);
}

describe("applyOrder", () => {
  it("returns the backend order verbatim when no frozen order exists", () => {
    const projects = [project(3), project(1), project(2)];
    expect(ids(applyOrder(projects, null))).toEqual([3, 1, 2]);
  });

  it("reorders projects to match the frozen order, ignoring backend order", () => {
    const projects = [project(2), project(3), project(1)]; // backend re-sorted
    expect(ids(applyOrder(projects, [3, 1, 2]))).toEqual([3, 1, 2]);
  });

  it("places unknown (newly-created) ids at the front in backend order", () => {
    // 5 and 9 are not in the frozen order yet; they should lead, keeping their
    // relative backend order via the stable sort.
    const projects = [project(2), project(9), project(1), project(5)];
    expect(ids(applyOrder(projects, [1, 2]))).toEqual([9, 5, 1, 2]);
  });

  it("drops frozen ids no longer present in the backend list", () => {
    const projects = [project(2), project(1)]; // project 3 was deleted
    expect(ids(applyOrder(projects, [3, 1, 2]))).toEqual([1, 2]);
  });
});

describe("orderProjects", () => {
  const feature = (projectId: number, at: string) =>
    ({
      id: projectId * 10,
      project_id: projectId,
      created_at: at,
      last_activity_at: at,
    }) as Feature;

  it("puts the project with the newest active conversation first, idle projects after in backend order", () => {
    const projects = [project(1), project(2), project(3), project(4)];
    const features = [
      feature(3, "2026-10-12T09:00:00Z"),
      feature(1, "2026-10-10T09:00:00Z"),
      feature(3, "2026-10-01T09:00:00Z"),
    ];
    expect(ids(orderProjects(projects, "live", null, features))).toEqual([3, 1, 2, 4]);
  });

  it("sorts by name the way people read them, or keeps the frozen order", () => {
    const named = [
      { id: 1, name: "web-v10" },
      { id: 2, name: "Api" },
      { id: 3, name: "web-v9" },
    ];
    expect(ids(orderProjects(named, "name", null, []))).toEqual([2, 3, 1]);
    expect(ids(orderProjects(named, "frozen", [3, 1, 2], []))).toEqual([3, 1, 2]);
  });
});
