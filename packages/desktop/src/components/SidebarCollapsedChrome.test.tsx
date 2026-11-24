import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/sidebar-attention-context";
import type { ResolvedAttentionResult } from "@/hooks/useResolvedAttention";
import { SidebarCollapsedChrome } from "./SidebarCollapsedChrome";

const layout = vi.hoisted(() => ({ docked: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/hooks/useDockedSidebar", () => ({ useDockedSidebar: () => layout.docked }));
beforeEach(() => {
  layout.docked = false;
});
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));

const ATTENTION: ResolvedAttentionResult = {
  entries: [],
  items: [],
  queue: [],
  byProject: new Map(),
  loadingStates: [],
  actionsLoading: false,
  actions: [
    { feature: { id: 1, project_id: 1 } as Feature, kind: "waiting" },
    { feature: { id: 2, project_id: 1 } as Feature, kind: "review" },
  ],
};

function renderChrome(props: { menuBadge?: boolean; currentFeatureId?: number }) {
  return render(
    <SidebarAttentionContext.Provider value={ATTENTION}>
      <SidebarCollapsedChrome visible onExpand={vi.fn()} {...props} />
    </SidebarAttentionContext.Provider>,
  );
}

describe("SidebarCollapsedChrome on a phone", () => {
  it("counts what waits elsewhere on the menu button of a conversation", () => {
    renderChrome({ currentFeatureId: 2 });
    expect(screen.getByRole("button")).toHaveAccessibleName("Open menu , 1 for you");
  });

  it("leaves the count off where the page lists For me itself (the inbox)", () => {
    renderChrome({ menuBadge: false });
    expect(screen.getByRole("button")).toHaveAccessibleName("Open menu");
  });

  it("keeps the menu button just clear of the edge-swipe strip without traffic lights", () => {
    renderChrome({});
    expect(screen.getByRole("button")).toHaveClass("ml-1");
    expect(screen.getByRole("button")).not.toHaveClass("ml-[68px]");
  });
});

describe("SidebarCollapsedChrome beside a docked phone sidebar", () => {
  it("leaves expanding to the rail, as on the desktop", () => {
    layout.docked = true;
    renderChrome({});
    expect(screen.queryByRole("button", { name: /Open menu/ })).toBeNull();
  });
});
