// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";

const mocks = vi.hoisted(() => ({
  search: {} as { tab?: string; section?: string },
  navigate: vi.fn(),
  history: { index: 0, go: vi.fn() },
  persist: vi.fn(),
  realSetting: false,
  isMobile: false,
  shortcuts: new Map<string, (event: { preventDefault: () => void }) => void>(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () => (options: { beforeLoad: (context: { search: typeof mocks.search }) => void }) => ({
      options,
    }),
  // The page itself is the lazy half of the route (`settings.lazy.tsx`).
  createLazyFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useSearch: () => mocks.search,
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({
    history: {
      location: { state: { __TSR_index: mocks.history.index } },
      go: mocks.history.go,
    },
  }),
}));
vi.mock("@/hooks/useShortcut", () => ({
  useShortcut: (id: string, callback: (event: { preventDefault: () => void }) => void) => {
    mocks.shortcuts.set(id, callback);
  },
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock("@/api/generated", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    getGetWorkspaceSettingQueryKey: (key: string) => ["workspace", "setting", key],
    useGetWorkspaceSetting: (key: string) =>
      useQuery({
        queryKey: ["workspace", "setting", key],
        queryFn: () => ({ value: "old" }),
        initialData: { value: "old" },
        staleTime: Infinity,
      }),
    setWorkspaceSetting: (key: string, data: { value: string }) => {
      mocks.persist({ key, data });
      return Promise.resolve({ value: data.value });
    },
  };
});
vi.mock("@/components/settings/SettingsPageContent", async () => {
  const { useSettingDraft } = await import("@/hooks/useSettingDraft");
  function SettingFixture() {
    const setting = useSettingDraft("regression_setting", 300);
    return (
      <input
        aria-label="Setting regression"
        value={setting.draft ?? setting.value ?? ""}
        onChange={(event) => setting.setDraft(event.target.value)}
      />
    );
  }
  return {
    SettingsPageContent: ({ pageId }: { pageId: string }) =>
      mocks.realSetting ? <SettingFixture /> : <div id={pageId}>Page {pageId}</div>,
  };
});
vi.mock("@/components/settings/SettingsNavSidebar", () => ({
  SettingsNavSidebar: ({
    variant = "rail",
    query,
    onQueryChange,
    onNavigate,
    searchRef,
  }: {
    variant?: string;
    query: string;
    onQueryChange: (query: string) => void;
    onNavigate: (section: string) => void;
    searchRef?: { current: HTMLInputElement | null };
  }) => (
    <nav aria-label={`Settings ${variant}`}>
      <input
        ref={searchRef}
        aria-label="Search settings"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <button type="button" onClick={() => onNavigate("git")}>
        Open Git
      </button>
    </nav>
  ),
}));
import { Route } from "./settings";
import { Route as LazyRoute } from "./settings.lazy";
const SettingsPage = LazyRoute.options.component as ComponentType;
const beforeLoad = Route.options.beforeLoad as unknown as (context: {
  search: { tab?: string; section?: string };
}) => void;

afterEach(() => {
  cleanup();
  mocks.search = {};
  mocks.navigate.mockClear();
  mocks.persist.mockClear();
  mocks.realSetting = false;
  mocks.isMobile = false;
  mocks.history.index = 0;
  mocks.history.go.mockClear();
  window.localStorage.clear();
  mocks.shortcuts.clear();
  vi.useRealTimers();
});

describe("Settings page", () => {
  it("opens the General page under a compact header by default", () => {
    render(<SettingsPage />);
    const header = screen.getByRole("heading", { name: "Settings" }).closest("header");
    expect(header).toContainElement(screen.getByRole("button", { name: "Back to workspace" }));
    expect(header).toHaveClass("min-h-11", "items-center");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Page general")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Settings rail" })).toBeTruthy();
  });

  it.each([
    ["interface", "general"],
    ["auto-naming", "agents"],
    ["sidebar-views", "sidebar"],
    ["git-remotes", "git"],
    ["providers", "providers"],
    ["no-such-section", "general"],
  ])("opens the page that holds ?section=%s", (section, page) => {
    mocks.search = { section };
    render(<SettingsPage />);
    expect(screen.getByText(`Page ${page}`)).toBeTruthy();
  });

  it("lists the pages on phones until one is picked", () => {
    mocks.isMobile = true;
    render(<SettingsPage />);
    expect(screen.getByRole("navigation", { name: "Settings index" })).toBeTruthy();
    expect(screen.queryByText(/^Page /)).toBeNull();
  });

  it("offers the way back to every page on a phone", () => {
    mocks.isMobile = true;
    mocks.search = { section: "git" };
    render(<SettingsPage />);
    expect(screen.getByText("Page git")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All settings" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: {} });
  });

  it("goes back on a phone to the page Settings was opened from, past its own pages", () => {
    mocks.isMobile = true;
    mocks.history.index = 4;
    const { rerender } = render(<SettingsPage />);
    // Two settings pages visited since: the route stays mounted.
    mocks.history.index = 6;
    mocks.search = { section: "git" };
    rerender(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.history.go).toHaveBeenCalledWith(-3);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("never reloads on a phone when Settings remounted on a later entry than it opened on", () => {
    mocks.isMobile = true;
    // A Back into a later settings entry remounts the route there.
    mocks.history.index = 6;
    const { rerender } = render(<SettingsPage />);
    // Back once more inside Settings: the earliest entry seen is now 5.
    mocks.history.index = 5;
    rerender(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.history.go).toHaveBeenCalledWith(-1);
    expect(mocks.history.go).not.toHaveBeenCalledWith(0);
  });

  it("reopens the last conversation on a phone when Settings has no page before it", () => {
    mocks.isMobile = true;
    window.localStorage.setItem(
      "cadencr:last-opened-feature",
      JSON.stringify({ projectId: 2, featureId: 9 }),
    );
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.history.go).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "2", featureId: "9" },
    });
  });

  it("opens the inbox on a phone with neither a page before Settings nor a last conversation", () => {
    mocks.isMobile = true;
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("leaves for the workspace home on desktop, whatever the history", () => {
    mocks.history.index = 4;
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(mocks.history.go).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("clears the search on Escape before leaving Settings", () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "vim" },
    });
    const escape = mocks.shortcuts.get("settings-back");
    act(() => escape?.({ preventDefault: () => {} }));
    expect(screen.getByRole("textbox", { name: "Search settings" })).toHaveValue("");
    expect(mocks.navigate).not.toHaveBeenCalled();
    act(() => escape?.({ preventDefault: () => {} }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("focuses the search field on the search shortcut", () => {
    render(<SettingsPage />);
    act(() => mocks.shortcuts.get("settings-search")?.({ preventDefault: () => {} }));
    expect(screen.getByRole("textbox", { name: "Search settings" })).toHaveFocus();
  });

  it("leaves the search shortcut and Escape to the page while a phone hides the rail", () => {
    mocks.isMobile = true;
    const { rerender } = render(<SettingsPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "vim" },
    });
    mocks.search = { section: "git" };
    rerender(<SettingsPage />);

    const preventDefault = vi.fn();
    act(() => mocks.shortcuts.get("settings-search")?.({ preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();

    // The leftover query isn't on screen, so Escape leaves at once.
    act(() => mocks.shortcuts.get("settings-back")?.({ preventDefault }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("scrolls the open page back to its top when it is picked again", () => {
    mocks.search = { section: "git" };
    render(<SettingsPage />);
    const main = screen.getByRole("main");
    main.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "Open Git" }));
    expect(main.scrollTop).toBe(0);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "git" } });
  });

  it.each([{ tab: "marketplace" }, { section: "marketplace" }])(
    "redirects the legacy marketplace link %j to the Marketplace page",
    (search) => {
      expect(() => beforeLoad({ search })).toThrow();
      try {
        beforeLoad({ search });
      } catch (error) {
        expect(error).toEqual({ redirect: { to: "/marketplace" } });
      }
    },
  );

  it("persists a real setting draft once", async () => {
    vi.useFakeTimers();
    mocks.realSetting = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Setting regression" }), {
      target: { value: "new" },
    });
    expect(mocks.persist).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledWith({
      key: "regression_setting",
      data: { value: "new" },
    });
  });
});
