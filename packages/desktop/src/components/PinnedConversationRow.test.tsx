import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { ShortcutHintsProvider } from "@/hooks/useNavShortcutHints";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { dispatchSidebarRowAction, type SidebarRowAction } from "@/lib/sidebar-row-actions";
import { useSidebarPointedFeatureStore } from "@/stores/sidebar-pointed-feature-store";
import { PinnedConversationRow } from "./PinnedConversationRow";

const mocks = vi.hoisted(() => ({
  title: { title: null as string | null, isAutoNaming: false },
  actions: null as null | {
    togglePin: ReturnType<typeof vi.fn>;
    archiveOrDelete: ReturnType<typeof vi.fn>;
    unarchive: ReturnType<typeof vi.fn>;
    closeActivity: ReturnType<typeof vi.fn>;
  },
}));
beforeEach(() => {
  mocks.title = { title: null, isAutoNaming: false };
  mocks.actions = null;
});

vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => <span>Project</span> }));
vi.mock("@/hooks/useFeaturePrefetch", () => ({ useFeaturePrefetch: () => vi.fn() }));
vi.mock("@/hooks/useFeatureTitle", () => ({
  useFeatureTitle: () => mocks.title,
}));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListFeatures: () => ({ data: [{ id: 7, label: "design" }] }),
}));
vi.mock("@/components/SidebarRowActionsProvider", () => ({
  useSidebarRowActions: () => mocks.actions,
}));
vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

const feature = {
  id: 42,
  project_id: 1,
  title: "Pinned conversation",
  runtime_provider: "codex_cli",
} as Feature;

describe("pinned sidebar identity", () => {
  it("uses the trailing logo/number slot and the same modifier navigation", () => {
    const onNavigate = vi.fn();
    render(
      <ShortcutHintsProvider enabled>
        <PinnedConversationRow
          feature={feature}
          activeFeatureId={null}
          onNavigate={onNavigate}
          showUnpin
        />
      </ShortcutHintsProvider>,
    );
    const row = screen.getByRole("button", { name: /Pinned conversation/ });
    const titleLine = row.querySelector("[data-feature-title-line]");
    expect(titleLine?.lastElementChild).toHaveAttribute("data-sidebar-identity-slot");
    expect(screen.getByLabelText("Agent idle")).toBeInTheDocument();
    const modifier = PLATFORM_IS_MAC ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(window, { key: PLATFORM_IS_MAC ? "Meta" : "Control", ...modifier });
    expect(row.querySelector("[data-nav-shortcut-badge]")).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(window, { key: "1", ...modifier });
    expect(onNavigate).toHaveBeenCalledWith(feature);
  });
});

describe("pointed conversation", () => {
  afterEach(() => useSidebarPointedFeatureStore.getState().setPointedFeature(null));

  it("lights the row up while its conversation is pointed at elsewhere", () => {
    render(<PinnedConversationRow feature={feature} activeFeatureId={null} onNavigate={vi.fn()} />);
    const row = screen.getByRole("button", { name: /Pinned conversation/ });
    expect(row).not.toHaveAttribute("data-sidebar-pointed");

    act(() => useSidebarPointedFeatureStore.getState().setPointedFeature(42));
    expect(row).toHaveAttribute("data-sidebar-pointed");

    act(() => useSidebarPointedFeatureStore.getState().setPointedFeature(7));
    expect(row).not.toHaveAttribute("data-sidebar-pointed");
  });
});

function renderRow(activeFeatureId: number | null = null) {
  const onNavigate = vi.fn();
  const view = render(
    <PinnedConversationRow
      feature={feature}
      activeFeatureId={activeFeatureId}
      onNavigate={onNavigate}
      showUnpin
    />,
  );
  return { ...view, onNavigate };
}

function sidebarActions() {
  const actions = {
    togglePin: vi.fn(),
    archiveOrDelete: vi.fn(),
    unarchive: vi.fn(),
    closeActivity: vi.fn(),
  };
  mocks.actions = actions;
  return actions;
}

describe("PinnedConversationRow", () => {
  it("falls back to the REST title when no live title has arrived", () => {
    renderRow();
    expect(screen.getByText("Pinned conversation")).toBeInTheDocument();
  });
  it("prefers the live WS-pushed title when present", () => {
    mocks.title = { title: "Live Title", isAutoNaming: false };
    renderRow();
    expect(screen.getByText("Live Title")).toBeInTheDocument();
    expect(screen.queryByText("Pinned conversation")).not.toBeInTheDocument();
  });
  it("shows a skeleton instead of the title while auto-naming", () => {
    mocks.title = { title: null, isAutoNaming: true };
    renderRow();
    expect(screen.queryByText("Pinned conversation")).not.toBeInTheDocument();
  });
  it("navigates on row click", async () => {
    const { user, onNavigate } = renderRow();
    await user.click(screen.getByText("Pinned conversation"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
  it("does not navigate when the row is already active", async () => {
    const { user, onNavigate } = renderRow(feature.id);
    await user.click(screen.getByText("Pinned conversation"));
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("unpins without navigating when the unpin button is clicked", async () => {
    const actions = sidebarActions();
    const { user, onNavigate } = renderRow();
    await user.click(screen.getByRole("button", { name: "Unpin" }));
    expect(actions.togglePin).toHaveBeenCalledWith(feature.id, false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("offers no unpin button outside the sidebar", () => {
    renderRow();
    expect(screen.queryByRole("button", { name: "Unpin" })).not.toBeInTheDocument();
  });
});

describe("PinnedConversationRow context menu", () => {
  it("leaves the browser's menu alone outside the sidebar", () => {
    renderRow();
    fireEvent.contextMenu(screen.getByText("Pinned conversation"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the project row's menu and runs the sidebar's actions", async () => {
    const actions = sidebarActions();
    const { user } = renderRow();
    fireEvent.contextMenu(screen.getByText("Pinned conversation"));
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(actions.togglePin).toHaveBeenCalledWith(feature.id, true);

    fireEvent.contextMenu(screen.getByText("Pinned conversation"));
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(actions.archiveOrDelete).toHaveBeenCalledWith(feature);
  });

  it("answers the row shortcuts: label inline, pin, archive", () => {
    const actions = sidebarActions();
    renderRow();
    const row = screen.getByRole("button", { name: /Pinned conversation/ });
    const dispatch = (action: SidebarRowAction): boolean => {
      let handled = false;
      act(() => {
        handled = dispatchSidebarRowAction(row, action);
      });
      return handled;
    };
    expect(dispatch("pin")).toBe(true);
    expect(actions.togglePin).toHaveBeenCalledWith(feature.id, true);
    expect(dispatch("archive")).toBe(true);
    expect(actions.archiveOrDelete).toHaveBeenCalledWith(feature);
    expect(dispatch("label")).toBe(true);
    expect(screen.getByText("Set label")).toBeInTheDocument();
  });

  it("can't act from a shortcut outside the sidebar", () => {
    renderRow();
    const row = screen.getByRole("button", { name: /Pinned conversation/ });
    expect(dispatchSidebarRowAction(row, "archive")).toBe(false);
  });
});
