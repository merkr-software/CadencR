import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import { afterEach } from "vitest";
import {
  getGetFeatureQueryKey,
  getGetWorkspaceSettingQueryKey,
  type Feature,
} from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG, SIDEBAR_OPTIONS } from "@/lib/sidebar-config";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useUnreadStore } from "@/stores/unread-store";
import { SidebarAttentionProvider } from "./SidebarAttentionProvider";
import { SidebarWorkingSection } from "./SidebarWorkingSection";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
// A saved write lands in the mirrored config, as `SidebarConfigProvider` would put it.
vi.mock("@/hooks/useSidebarSettings", async () => {
  const { useSidebarConfigStore } = await import("@/stores/sidebar-config-store");
  return {
    useSetSidebarOption: () => (id: string, value: unknown) =>
      useSidebarConfigStore.setState((state) => ({ config: { ...state.config, [id]: value } })),
  };
});
vi.mock("@/components/PinnedConversationRow", () => ({
  PinnedConversationRow: ({ feature }: { feature: Feature }) => (
    <div role="row">{feature.title}</div>
  ),
}));

function seededClient({ foldsLoaded = true } = {}) {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  client.setQueryData(["/api/projects"], []);
  // The saved folds have loaded, so the header may fold.
  if (foldsLoaded) {
    client.setQueryData(getGetWorkspaceSettingQueryKey(SIDEBAR_OPTIONS.foldedSections.key), {
      value: null,
    });
  }
  for (const [id, title] of [
    [1, "Building"],
    [2, "Asks"],
    [3, "Testing"],
  ] as const) {
    client.setQueryData(getGetFeatureQueryKey(id), {
      id,
      title,
      project_id: 9,
      status: "active",
    } as Feature);
  }
  return client;
}

function renderSection(client = seededClient()) {
  return render(
    <SidebarAttentionProvider>
      <SidebarWorkingSection activeFeatureId={null} onSelectFeature={vi.fn()} />
    </SidebarAttentionProvider>,
    { queryClient: client },
  );
}

beforeEach(() => {
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, workingBlock: true } });
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {} });
  useSessionStatusStore.setState({
    bySession: {
      10: { featureId: 1, status: "agent", kind: null, seq: 1 },
      11: { featureId: 2, status: "question", kind: "question", seq: 2 },
      12: { featureId: 3, status: "agent", kind: null, seq: 3 },
    },
  });
  // Fold tests need synchronous mount/unmount (CollapsibleSection).
  document.documentElement.dataset.animations = "off";
});

afterEach(() => {
  delete document.documentElement.dataset.animations;
});

describe("SidebarWorkingSection", () => {
  it("lists every agent at work and nothing else", () => {
    renderSection();
    const section = screen.getByRole("region", { name: "In progress" });
    expect(
      within(section)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual(["Building", "Testing"]);
    expect(within(section).getByRole("button", { name: /In progress/ })).toHaveTextContent("2");
  });

  it("is off by default and hides once no agent works", () => {
    useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
    const { unmount } = renderSection();
    expect(screen.queryByRole("region", { name: "In progress" })).not.toBeInTheDocument();
    unmount();

    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, workingBlock: true } });
    renderSection();
    act(() => useSessionStatusStore.setState({ bySession: {} }));
    expect(screen.queryByRole("region", { name: "In progress" })).not.toBeInTheDocument();
  });

  it("folds from its header", () => {
    renderSection();
    const section = screen.getByRole("region", { name: "In progress" });
    act(() =>
      within(section)
        .getByRole("button", { name: /In progress/ })
        .click(),
    );
    expect(within(section).queryAllByRole("row")).toHaveLength(0);
    act(() =>
      within(section)
        .getByRole("button", { name: /In progress/ })
        .click(),
    );
    expect(within(section).getAllByRole("row")).toHaveLength(2);
  });

  it("keeps the saved folds until they have loaded, rather than overwrite them", () => {
    renderSection(seededClient({ foldsLoaded: false }));
    const section = screen.getByRole("region", { name: "In progress" });
    act(() =>
      within(section)
        .getByRole("button", { name: /In progress/ })
        .click(),
    );
    expect(useSidebarConfigStore.getState().config.foldedSections).toEqual([]);
    expect(within(section).getAllByRole("row")).toHaveLength(2);
  });
});
