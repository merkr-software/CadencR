import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/test-utils";
import type { Feature } from "@/api/generated";
import type { PinnedActivity } from "@/hooks/usePinnedActivity";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import type { LensGroup } from "@/lib/sidebar-lens";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useSidebarLensStore } from "@/stores/sidebar-lens-store";
import { SidebarLensList } from "./SidebarLensList";

vi.mock("@/hooks/useFeaturePrefetch", () => ({ useFeaturePrefetch: () => vi.fn() }));
vi.mock("@/hooks/useCrossProjectNavigate", () => ({ useCrossProjectNavigate: () => vi.fn() }));
vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => null }));
vi.mock("@/hooks/useFeaturePorts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useFeaturePorts")>()),
  useFeaturePorts: () => new Map(),
}));
vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

const activity: PinnedActivity = {
  shellCountByFeatureId: new Map(),
  liveWorktreeFeatureIds: new Set(),
  worktreeByFeatureId: new Map(),
};

function feature(id: number, title: string): Feature {
  return {
    id,
    project_id: 1,
    title,
    status: "active",
    type: "ws-session",
    is_pinned: false,
    created_at: "2026-10-01T00:00:00Z",
    last_activity_at: "2026-10-12T00:00:00Z",
  };
}

const groups: LensGroup[] = [
  { key: "status:waiting", lens: "status", value: "waiting", features: [feature(1, "Fix login")] },
  {
    key: "status:idle",
    lens: "status",
    value: "idle",
    features: [feature(2, "Write docs"), feature(3, "Plan sprint")],
  },
];

function renderList(props: Partial<Parameters<typeof SidebarLensList>[0]> = {}) {
  return render(
    <div data-radix-scroll-area-viewport>
      <SidebarLensList
        groups={groups}
        showHeaders
        activity={activity}
        isPending={false}
        emptyText="No conversations yet"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
        {...props}
      />
    </div>,
  );
}

beforeEach(() => {
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
  useSidebarLensStore.setState({ folded: new Set() });
});

describe("SidebarLensList", () => {
  it("lists each group under its header, with its count", () => {
    renderList();
    const list = screen.getByRole("list", { name: "Conversations" });
    expect(within(list).getByRole("button", { name: /Waiting on you\s*1/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Idle\s*2/ })).toBeInTheDocument();
    expect(within(list).getByText("Plan sprint")).toBeInTheDocument();
  });

  it("folds a group from its header", async () => {
    const { user } = renderList();
    await user.click(screen.getByRole("button", { name: /Idle\s*2/ }));
    expect(screen.queryByText("Plan sprint")).not.toBeInTheDocument();
    expect(screen.getByText("Fix login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Idle\s*2/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows rows only for the flat list, and says when there is nothing", () => {
    const { unmount } = renderList({ showHeaders: false });
    expect(screen.queryByRole("button", { name: /Idle/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Fix login|Write docs|Plan sprint/)).toHaveLength(3);
    unmount();
    renderList({ groups: [] });
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
  });
});
