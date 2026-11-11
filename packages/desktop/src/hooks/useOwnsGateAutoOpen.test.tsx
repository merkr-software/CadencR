import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import { useOwnsGateAutoOpen } from "@/hooks/useOwnsGateAutoOpen";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import {
  SidebarSurfaceContext,
  useSidebarSurfaceStore,
  type SidebarSurface,
} from "@/stores/sidebar-surface-store";

const newest = vi.hoisted(() => ({ featureId: null as number | null }));
const phone = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => phone.value }));
vi.mock("@/stores/pending-gate-popover-selectors", () => ({
  useNewestQuickReplyFeatureId: () => newest.featureId,
}));

const feature = (id: number) => ({ id, project_id: 1 }) as Feature;
const attention = {
  entries: [],
  items: [],
  queue: [],
  byProject: new Map(),
  loadingStates: [],
  actions: [1, 2, 3, 4].map((id) => ({ feature: feature(id), kind: "waiting" as const })),
  actionsLoading: false,
};

function ownsOn(surface: SidebarSurface) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SidebarAttentionContext.Provider value={attention}>
      <SidebarSurfaceContext.Provider value={surface}>{children}</SidebarSurfaceContext.Provider>
    </SidebarAttentionContext.Provider>
  );
  return renderHook(() => useOwnsGateAutoOpen(), { wrapper });
}

describe("useOwnsGateAutoOpen", () => {
  beforeEach(() => {
    phone.value = false;
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, forMeLimit: "3" } });
    useSidebarSurfaceStore.setState({ forMeShowAll: false });
  });

  it("lets For me open the newest request when it is among the shown actions", () => {
    newest.featureId = 3;
    expect(ownsOn("for-me").result.current).toBe(true);
    expect(ownsOn("tree").result.current).toBe(false);
  });

  it("hands the newest request to the tree while it sits behind Show more", () => {
    newest.featureId = 4;
    const forMe = ownsOn("for-me");
    const tree = ownsOn("tree");
    expect(forMe.result.current).toBe(false);
    expect(tree.result.current).toBe(true);

    act(() => useSidebarSurfaceStore.getState().toggleForMeShowAll());
    forMe.rerender();
    tree.rerender();
    expect(forMe.result.current).toBe(true);
    expect(tree.result.current).toBe(false);
  });

  it("keeps For me as the owner while the newest request is still being looked up", () => {
    newest.featureId = 99;
    expect(ownsOn("for-me").result.current).toBe(true);
  });

  it("owns nothing on a phone, whatever the drawer shows: a tap opens the sheet instead", () => {
    phone.value = true;
    newest.featureId = 3;
    expect(ownsOn("for-me").result.current).toBe(false);
    expect(ownsOn("tree").result.current).toBe(false);
    expect(ownsOn("rail").result.current).toBe(false);
  });
});
