import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetWorkspaceSettingQueryKey, type Feature } from "@/api/generated";

const mocks = vi.hoisted(() => {
  const navigate = vi.fn();
  let pinned: Feature[] = [];
  return {
    navigate,
    skipProjectAutoExpand: vi.fn(),
    manualOrder: [] as number[],
    queue: [] as { feature: Feature; state: string }[],
    setPinned: (features: Feature[]) => {
      pinned = features;
    },
    getPinned: (): Feature[] => pinned,
  };
});

vi.mock("@/api/generated", () => ({
  getGetWorkspaceSettingQueryKey: (key: string) => [`/api/workspace/settings/${key}`] as const,
  useListPinnedFeatures: () => ({ data: mocks.getPinned() }),
  useListProjects: () => ({
    data: [
      { id: 5, name: "Proj Five", path: "/p5" },
      { id: 9, name: "Proj Nine", path: "/p9" },
    ],
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/SidebarAttentionProvider", () => ({
  useSidebarAttention: () => ({ queue: mocks.queue }),
}));

vi.mock("@/lib/feature-focus-handoff", () => ({
  getFocusedTabForFeature: () => undefined,
}));

vi.mock("@/lib/project-auto-expand", () => ({
  skipProjectAutoExpand: mocks.skipProjectAutoExpand,
}));

// Ordering, ports, and activity have their own coverage; keep backend order and no badges.
vi.mock("@/hooks/useStableFeatureOrder", () => ({
  useStableFeatureOrder: (features: Feature[]) => features,
}));

vi.mock("@/hooks/useManualConversationOrder", () => ({
  useManualConversationOrder: () => mocks.manualOrder,
  moveConversation: vi.fn(),
}));

vi.mock("@/hooks/useFeaturePorts", () => ({
  NO_PORTS: [],
  useFeaturePorts: () => new Map(),
}));

// A saved write lands in the mirrored config, as `SidebarConfigProvider` would put it.
vi.mock("@/hooks/useSidebarSettings", async () => {
  const { useSidebarConfigStore } = await import("@/stores/sidebar-config-store");
  return {
    useSetSidebarOption: () => (id: string, value: unknown) =>
      useSidebarConfigStore.setState((state) => ({ config: { ...state.config, [id]: value } })),
  };
});
vi.mock("@/hooks/useLiveFeatureMeta", () => ({ useLiveFeatureMeta: () => ({}) }));

vi.mock("@/hooks/usePinnedActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/usePinnedActivity")>()),
  usePinnedActivity: () => ({
    shellCountByFeatureId: new Map(),
    liveWorktreeFeatureIds: new Set(),
    worktreeByFeatureId: new Map(),
  }),
}));

// Stub the row so this suite stays focused on the section's own behavior
// (fetch → header/empty, navigate) without wiring every store the row
// reads. The stub surfaces the props the section is responsible for.
vi.mock("@/components/PinnedConversationRow", () => ({
  PinnedConversationRow: ({
    feature,
    onNavigate,
    showUnpin,
  }: {
    feature: Feature;
    onNavigate: (f: Feature) => void;
    showUnpin: boolean;
  }) => (
    <div>
      <button onClick={() => onNavigate(feature)}>open-{feature.id}</button>
      {showUnpin && <span>unpin-{feature.id}</span>}
    </div>
  ),
}));

import { SidebarPinnedConversations } from "./SidebarPinnedConversations";
import { useSidebarFilterStore } from "@/stores/sidebar-filter-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import {
  DEFAULT_SIDEBAR_CONFIG,
  SIDEBAR_OPTIONS,
  type SidebarSectionId,
} from "@/lib/sidebar-config";

function setFolded(folded: readonly SidebarSectionId[]): void {
  useSidebarConfigStore.setState((state) => ({
    config: { ...state.config, foldedSections: folded },
  }));
}

function pinnedFolded(): boolean {
  return useSidebarConfigStore.getState().config.foldedSections.includes("pinned");
}
import {
  collectSidebarNavItems,
  useSidebarKeyboardNavigation,
} from "@/hooks/useSidebarKeyboardNavigation";

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

function KeyboardSidebar({ children }: { children: React.ReactNode }): React.ReactElement {
  const sidebarRef = React.useRef<HTMLElement>(null);
  useSidebarKeyboardNavigation(sidebarRef, mocks.navigate, null);
  return (
    <aside ref={sidebarRef} data-focus-zone="left-sidebar">
      {children}
    </aside>
  );
}

function renderSection(activeFeatureId: number | null = null, withKeyboard = false) {
  const client = new QueryClient();
  // The saved folds have loaded, so the header may fold.
  client.setQueryData(getGetWorkspaceSettingQueryKey(SIDEBAR_OPTIONS.foldedSections.key), {
    value: null,
  });
  const section = (
    <SidebarPinnedConversations activeFeatureId={activeFeatureId} onSelectFeature={vi.fn()} />
  );
  return render(
    <QueryClientProvider client={client}>
      {withKeyboard ? <KeyboardSidebar>{section}</KeyboardSidebar> : section}
    </QueryClientProvider>,
  );
}

describe("SidebarPinnedConversations", () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.skipProjectAutoExpand.mockClear();
    mocks.queue = [];
    mocks.manualOrder = [];
    mocks.setPinned([]);
    useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
    useSidebarFilterStore.getState().close();
    // Fold tests need synchronous mount/unmount (CollapsibleSection).
    document.documentElement.dataset.animations = "off";
  });

  afterEach(() => {
    delete document.documentElement.dataset.animations;
  });

  it("folds and unfolds the focused header with Enter through sidebar shortcuts", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 5)]);
    renderSection(null, true);
    const header = screen.getByRole("button", { name: /Pinned/ });
    const click = vi.fn();
    header.addEventListener("click", click);
    header.focus();

    await user.keyboard("{Enter}");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();
    expect(header).toHaveFocus();
    expect(click).toHaveBeenCalledTimes(1);

    await user.keyboard("{Enter}");
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("open-1")).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("preserves the folded choice after Enter on a filtered header and clearing the filter", async () => {
    const user = userEvent.setup();
    mocks.setPinned([{ ...feature(1, 5), title: "Login bug" }]);
    setFolded(["pinned"]);
    useSidebarFilterStore.getState().start("login");
    renderSection(null, true);
    const header = screen.getByRole("button", { name: /Pinned/ });
    const click = vi.fn();
    header.addEventListener("click", click);
    header.focus();

    await user.keyboard("{Enter}");
    expect(click).toHaveBeenCalledTimes(1);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("open-1")).toBeInTheDocument();
    expect(pinnedFolded()).toBe(true);

    act(() => useSidebarFilterStore.getState().close());
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();
  });

  it("keeps only the pinned rows the sidebar filter matches", () => {
    mocks.setPinned([feature(1, 5), { ...feature(2, 9), title: "Login bug" }]);
    useSidebarFilterStore.getState().start("login");
    renderSection();
    expect(screen.getByText("open-2")).toBeInTheDocument();
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();
  });

  it("hides the section when the filter matches no pinned row", () => {
    mocks.setPinned([feature(1, 5)]);
    useSidebarFilterStore.getState().start("zzz");
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
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

  it("follows the manual rank under the manual sort only", () => {
    mocks.setPinned([feature(1, 5), feature(2, 9), feature(3, 9)]);
    mocks.manualOrder = [3, 1];
    const openOrder = () =>
      screen.getAllByText(/^open-\d$/).map((button) => button.textContent ?? "");
    const { unmount } = renderSection();
    expect(openOrder()).toEqual(["open-1", "open-2", "open-3"]);
    unmount();

    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, conversationSort: "manual" },
    });
    renderSection();
    // 2 is unranked (pinned since the last drag): it shows first.
    expect(openOrder()).toEqual(["open-2", "open-3", "open-1"]);
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

  it("marks the parent project so the tree does not auto-expand it on navigation", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 9)]);
    renderSection();
    await user.click(screen.getByText("open-1"));
    expect(mocks.skipProjectAutoExpand).toHaveBeenCalledWith(9);
  });

  it("offers unpinning on its rows", () => {
    mocks.setPinned([feature(1, 5)]);
    renderSection();
    expect(screen.getByText("unpin-1")).toBeInTheDocument();
  });

  it("flags a folded block's pinned conversations that need an action", async () => {
    const user = userEvent.setup();
    const waiting = feature(2, 9);
    mocks.setPinned([feature(1, 5), waiting]);
    mocks.queue = [{ feature: waiting, state: "waiting" }];
    renderSection();
    await user.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(screen.queryByText("open-2")).not.toBeInTheDocument();
    expect(screen.getByText(/1 need an action/)).toBeInTheDocument();
  });

  it("folds its rows from the header", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 5)]);
    renderSection();
    const header = screen.getByRole("button", { name: /Pinned/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();
  });

  it("holds the block open on the filter's matches, even folded", () => {
    mocks.setPinned([{ ...feature(1, 5), title: "Login bug" }]);
    setFolded(["pinned"]);
    useSidebarFilterStore.getState().start("login");
    renderSection();
    expect(screen.getByText("open-1")).toBeInTheDocument();
  });

  it("folds from its header", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 5), feature(2, 9)]);
    renderSection();
    const header = screen.getByRole("button", { name: /Pinned/ });
    expect(screen.getByText("open-1")).toBeInTheDocument();
    await user.click(header);
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();
    expect(screen.queryByText("open-2")).not.toBeInTheDocument();
    await user.click(header);
    expect(screen.getByText("open-1")).toBeInTheDocument();
    expect(screen.getByText("open-2")).toBeInTheDocument();
  });

  it("excludes closing rows from keyboard navigation during the close animation", () => {
    // Animations ON: CollapsibleSection keeps children mounted for 200 ms
    // under aria-hidden while the close transition runs.
    delete document.documentElement.dataset.animations;
    vi.useFakeTimers();
    try {
      mocks.setPinned([feature(1, 5)]);
      const { container } = renderSection();
      const header = screen.getByRole("button", { name: /Pinned/ });

      // Fold via the store (the header's onClick path) inside act so React
      // flushes the state change before we inspect the DOM.
      act(() => {
        setFolded(["pinned"]);
      });

      // During the 200 ms close window the row is still mounted but hidden.
      const closingRow = screen.queryByText("open-1");
      expect(closingRow).not.toBeNull();
      expect(closingRow?.closest('[aria-hidden="true"]')).not.toBeNull();

      // Keyboard navigation must skip it: only the header remains reachable.
      const navItems = collectSidebarNavItems(container);
      expect(navItems).toContain(header);
      expect(navItems.some((el) => el.contains(closingRow))).toBe(false);

      // After the animation the row unmounts entirely.
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(screen.queryByText("open-1")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the block open while filtering, without changing the stored fold state", () => {
    mocks.setPinned([feature(1, 5), { ...feature(2, 9), title: "Login bug" }]);
    // Start folded: the stored state must stay folded throughout.
    setFolded(["pinned"]);
    renderSection();
    // Folded and unfiltered: rows are hidden.
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();

    // Filtering forces the block open so the matching pinned row is reachable.
    act(() => {
      useSidebarFilterStore.getState().start("login");
    });
    expect(screen.getByText("open-2")).toBeInTheDocument();
    expect(screen.queryByText("open-1")).not.toBeInTheDocument();
    expect(pinnedFolded()).toBe(true);

    // Clearing the filter restores the stored fold state.
    act(() => {
      useSidebarFilterStore.getState().close();
    });
    expect(screen.queryByText("open-2")).not.toBeInTheDocument();
    expect(pinnedFolded()).toBe(true);
  });

  it("does not toggle the stored fold state when the header is clicked while filtering", async () => {
    const user = userEvent.setup();
    mocks.setPinned([feature(1, 5), { ...feature(2, 9), title: "Login bug" }]);
    // Start folded: clicking the open-looking header during filtering must
    // not flip the stored state.
    setFolded(["pinned"]);
    renderSection();
    act(() => {
      useSidebarFilterStore.getState().start("login");
    });
    // The block is held open by the filter.
    expect(screen.getByText("open-2")).toBeInTheDocument();

    // Clicking the header is a no-op while filtering.
    await user.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(pinnedFolded()).toBe(true);
    // The row stays visible (the filter still holds the block open).
    expect(screen.getByText("open-2")).toBeInTheDocument();

    // After the filter clears, the stored fold state resumes.
    act(() => {
      useSidebarFilterStore.getState().close();
    });
    expect(screen.queryByText("open-2")).not.toBeInTheDocument();
    expect(pinnedFolded()).toBe(true);
  });
});
