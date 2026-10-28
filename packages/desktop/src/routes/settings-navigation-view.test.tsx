// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";

const mocks = vi.hoisted(() => ({
  search: {} as { tab?: string; section?: string },
  navigate: vi.fn(),
  persist: vi.fn(),
  realSetting: false,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      component: ComponentType;
      beforeLoad: (context: { search: typeof mocks.search }) => void;
    }) => ({
      options,
      useSearch: () => mocks.search,
    }),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/useShortcut", () => ({ useShortcut: vi.fn() }));
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
    useSetWorkspaceSetting: () => ({
      mutate: mocks.persist,
      mutateAsync: (args: { data: { value: string } }) => {
        mocks.persist(args);
        return Promise.resolve({ value: args.data.value });
      },
      isPending: false,
    }),
  };
});
vi.mock("@/components/settings/GeneralSettingsSections", async () => {
  const { useDebouncedSetting } = await import("@/hooks/useDebouncedSetting");
  function SettingFixture() {
    const setting = useDebouncedSetting("regression_setting");
    return (
      <input
        aria-label="Setting regression"
        value={setting.value ?? ""}
        onChange={(event) => setting.setValue(event.target.value)}
      />
    );
  }
  return {
    GeneralSettingsSections: () =>
      mocks.realSetting ? <SettingFixture /> : <div id="appearance">General content</div>,
  };
});
vi.mock("@/components/settings/SettingsNavSidebar", () => ({
  SettingsNavSidebar: () => <nav aria-label="General sections" />,
}));
import { Route } from "./settings";
const SettingsPage = Route.options.component as ComponentType;
const beforeLoad = Route.options.beforeLoad as unknown as (context: {
  search: { tab?: string; section?: string };
}) => void;

afterEach(() => {
  cleanup();
  mocks.search = {};
  mocks.navigate.mockClear();
  mocks.persist.mockClear();
  mocks.realSetting = false;
  vi.useRealTimers();
});

describe("Settings page", () => {
  it("renders the general sections under a compact header", () => {
    render(<SettingsPage />);
    const header = screen.getByRole("heading", { name: "Settings" }).closest("header");
    expect(header).toContainElement(screen.getByRole("button", { name: "Back to workspace" }));
    expect(header).toHaveClass("min-h-11", "items-center");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("General content")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "General sections" })).toBeTruthy();
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

  it("persists a real debounced setting once", async () => {
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
