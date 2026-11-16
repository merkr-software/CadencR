import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ProjectFeatures } from "./ProjectFeatures";

const { controller } = vi.hoisted(() => ({
  controller: {
    dormantFeatures: [] as unknown[],
    actions: { deleteFeature: vi.fn(), updateStatus: vi.fn() },
    renderedActiveFeatureCount: 1_001,
    orderedIds: [] as number[],
    archivedFeatures: [] as Array<{ id: number }>,
    confirmFeatureId: null,
    confirmation: { action: "archive", cleanup: {}, feature: undefined },
    flatActiveFeatures: [],
    renderFeature: vi.fn(),
    renderSubtree: vi.fn(),
    rootNodeByFeatureId: new Map(),
    setConfirmFeatureId: vi.fn(),
    setShowArchived: vi.fn(),
    showArchived: false,
    worktreeGroups: [],
  },
}));

vi.mock("@/components/ArchiveFeatureDialog", () => ({ ArchiveFeatureDialog: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/ArchivedFeatureList", () => ({
  ArchivedFeatureList: () => <div data-testid="plain-archived-features" />,
  ArchivedFeatureSection: () => null,
}));
vi.mock("@/components/VirtualizedArchivedFeatureList", () => ({
  VirtualizedArchivedFeatureList: () => <div data-testid="virtual-archived-features" />,
}));
vi.mock("@/components/VirtualizedProjectFeatureList", () => ({
  VirtualizedProjectFeatureList: () => <div data-testid="virtual-project-features" />,
}));
vi.mock("@/components/ProjectFeaturesController", () => ({
  ARCHIVED_FEATURE_STATUS: "archived",
  useProjectFeaturesController: () => controller,
}));

describe("ProjectFeatures virtualization selection", () => {
  beforeEach(() => {
    controller.renderedActiveFeatureCount = 1_001;
    controller.archivedFeatures = [];
  });

  it("uses the virtual path when a single root has many active descendants", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/project"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    expect(screen.getByTestId("virtual-project-features")).toBeInTheDocument();
  });

  it("does not virtualize a tiny active list just because archives are large", () => {
    controller.renderedActiveFeatureCount = 1;
    controller.archivedFeatures = Array.from({ length: 21 }, (_, id) => ({ id }));

    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/project"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("virtual-project-features")).not.toBeInTheDocument();
    expect(screen.getByTestId("virtual-archived-features")).toBeInTheDocument();
  });

  it("keeps a small archive on the plain path when active conversations are large", () => {
    controller.renderedActiveFeatureCount = 21;
    controller.archivedFeatures = [{ id: 1 }];

    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/project"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    expect(screen.getByTestId("virtual-project-features")).toBeInTheDocument();
    expect(screen.queryByTestId("virtual-archived-features")).not.toBeInTheDocument();
    expect(screen.getByTestId("plain-archived-features")).toBeInTheDocument();
  });
});
