import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { UnifiedAgentsNewFeatureButton } from "./UnifiedAgentsNewFeatureButton";
import type { Project } from "@/api/generated";

const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

// ProjectBadge pulls in project-settings queries we don't care about here.
vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: () => null,
}));

const mocks = vi.hoisted(() => ({ createFeature: vi.fn() }));
vi.mock("@/api/generated", () => ({
  useCreateFeature: vi.fn(() => ({ mutate: mocks.createFeature })),
  getListFeaturesQueryKey: vi.fn(
    (params?: { project_id?: number }) => ["/api/features", params] as const,
  ),
}));

const projects: Project[] = [
  { id: 1, name: "Alpha", path: "/a", created_at: "2020-01-01T00:00:00Z", path_missing: false },
  { id: 2, name: "Beta", path: "/b", created_at: "2020-01-01T00:00:00Z", path_missing: false },
];

describe("UnifiedAgentsNewFeatureButton", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mocks.createFeature.mockClear();
  });

  it("renders the New button", () => {
    render(<UnifiedAgentsNewFeatureButton projects={projects} />);
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
  });

  it("opens the project picker and creates a session in the chosen project", async () => {
    const { user } = render(<UnifiedAgentsNewFeatureButton projects={projects} />);
    await user.click(screen.getByRole("button", { name: "New session" }));
    await user.click(await screen.findByText("Beta"));
    expect(mocks.createFeature).toHaveBeenCalledWith({
      data: { project_id: 2, type: "ws-session" },
    });
  });
});
