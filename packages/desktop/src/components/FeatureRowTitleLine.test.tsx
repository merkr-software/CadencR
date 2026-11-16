import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { DEFAULT_SIDEBAR_CONFIG, type SidebarConfig } from "@/lib/sidebar-config";
import type { AttentionState } from "@/lib/sidebar-attention";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { FeatureRowTitleLine, rowTitle } from "./FeatureRowTitleLine";

vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/components/SidebarPendingGatePopover", () => ({
  SidebarPendingGatePopover: ({ featureId }: { featureId: number }) => (
    <div data-testid="pending-gate">gate-{featureId}</div>
  ),
}));

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 5,
    project_id: 1,
    title: "A feature",
    status: "active",
    type: "ws-session",
    label: null,
    is_pinned: false,
    runtime_provider: "codex_cli",
    created_at: "2026-07-01 00:00:00",
    updated_at: "2026-07-01 00:00:00",
    ...overrides,
  } as Feature;
}

const worktree = {
  feature_id: 5,
  worktree_path: "/repo/.worktrees/fix-login",
  worktree_branch: "fix/login",
  directory_exists: true,
  is_default_branch: false,
  is_main_worktree: false,
  live: true,
} satisfies FeatureWorktreeInfo;

function configure(overrides: Partial<SidebarConfig>): void {
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, ...overrides } });
}

function row(
  state: AttentionState = "idle",
  overrides: {
    feature?: Feature;
    sourceFeatureId?: number;
    hasWorktree?: boolean;
    isActive?: boolean;
  } = {},
) {
  return render(
    <FeatureRowTitleLine
      feature={overrides.feature ?? feature()}
      liveTitle={undefined}
      isAutoNaming={false}
      isArchived={false}
      hasWorktree={overrides.hasWorktree ?? false}
      worktree={worktree}
      attention={{ state, sourceFeatureId: overrides.sourceFeatureId ?? 5 }}
      isActive={overrides.isActive ?? false}
      onOpenConversation={vi.fn()}
    />,
  );
}

beforeEach(() => configure({ time: "none" }));

describe("FeatureRowTitleLine", () => {
  it("puts the quiet logo at the very end of the title line", () => {
    row("idle");
    const line = document.querySelector("[data-feature-title-line]");
    expect(line).toHaveClass("min-h-6");
    expect(line?.firstElementChild).toHaveAttribute("data-sidebar-status", "idle");
    expect(line?.lastElementChild).toHaveAttribute("data-sidebar-identity-slot");
    expect(line?.lastElementChild?.querySelector("[data-provider-mark]")).toHaveAttribute(
      "data-provider-mark",
      "mono",
    );
    expect(screen.getByText("A feature")).toHaveClass("truncate", "flex-1", "min-w-8");
  });

  it("shows working separately without tinting the logo", () => {
    row("working");
    expect(screen.getByLabelText("Agent working")).toHaveClass("sidebar-status-working");
    expect(screen.getByRole("img", { name: /Codex/ })).toHaveClass("text-muted-foreground");
    expect(screen.queryByLabelText("Unread agent messages")).not.toBeInTheDocument();
  });

  it("keeps unread distinct from working", () => {
    row("unread");
    expect(screen.getByLabelText("Unread agent messages")).toHaveClass("sidebar-status-unread");
    expect(screen.queryByLabelText("Agent working")).not.toBeInTheDocument();
  });

  it("quiets idle titles, keeping full contrast for the open one and every other state", () => {
    const tone = () => document.querySelector("[data-feature-title]")?.getAttribute("data-tone");
    const { unmount } = row("idle");
    expect(tone()).toBe("quiet");
    unmount();

    const active = row("idle", { isActive: true });
    expect(tone()).toBe("normal");
    active.unmount();

    row("unread");
    expect(tone()).toBe("normal");
  });

  it("answers a hidden child's request from the parent row", () => {
    row("waiting", { sourceFeatureId: 9 });
    expect(screen.getByTestId("pending-gate")).toHaveTextContent("gate-9");
    expect(screen.getByRole("img", { name: /Codex/ })).toBeInTheDocument();
  });
});

describe("FeatureRowTitleLine display options", () => {
  it("leads with the branch or folder, keeping the title on hover", () => {
    configure({ time: "none", titleSource: "branch" });
    const { unmount } = row();
    expect(screen.getByText("fix/login")).toHaveAttribute("title", "A feature");
    unmount();

    configure({ time: "none", titleSource: "folder" });
    row();
    expect(screen.getByText("fix-login")).toBeInTheDocument();
  });

  it("hides the worktree marker on request", () => {
    const { unmount } = row("idle", { hasWorktree: true });
    expect(screen.getByLabelText("Has worktree")).toBeInTheDocument();
    unmount();

    configure({ time: "none", worktreeIcon: false });
    row("idle", { hasWorktree: true });
    expect(screen.queryByLabelText("Has worktree")).not.toBeInTheDocument();
  });

  it("shows the last activity, relative or absolute", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T03:00:00Z"));
    configure({ time: "relative" });
    const { unmount } = row("idle", {
      feature: feature({ last_activity_at: "2026-07-01 02:55:00" }),
    });
    expect(document.querySelector("[data-feature-time]")).toHaveTextContent("5m");
    unmount();

    configure({ time: "absolute" });
    row("idle", { feature: feature({ last_activity_at: "2026-06-03 10:00:00" }) });
    expect(document.querySelector("[data-feature-time]")).toHaveTextContent("Jun 3");
    vi.useRealTimers();
  });

  it("keeps a pending request visible with the status hidden", () => {
    configure({ time: "none", status: "hidden" });
    const { unmount } = row("working");
    expect(document.querySelector("[data-sidebar-status]")).toBeNull();
    unmount();

    row("waiting");
    expect(screen.getByTestId("pending-gate")).toBeInTheDocument();
  });

  it("uses a dot for the quieter status style", () => {
    configure({ time: "none", status: "dot" });
    row("working");
    expect(screen.getByLabelText("Agent working")).toHaveClass("sidebar-status-dot-working");
  });
});

describe("rowTitle", () => {
  it("falls back to the title without a worktree of its own", () => {
    expect(rowTitle("T", undefined, "branch")).toBe("T");
    expect(rowTitle("T", { ...worktree, is_main_worktree: true }, "folder")).toBe("T");
    expect(rowTitle("T", worktree, "title")).toBe("T");
  });
});
