import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test-utils";
import { ThemeMarketplace } from "./ThemeMarketplace";

const mocks = vi.hoisted(() => ({ themeId: "cadencr-dark", mutate: vi.fn(), damaged: false }));
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ themeId: mocks.themeId, isLoading: false }),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, entry: unknown) => React.ReactNode;
  }) => data.map((entry, index) => itemContent(index, entry)),
}));
vi.mock("@/lib/theme-marketplace", async (original) => ({
  ...(await original<typeof import("@/lib/theme-marketplace")>()),
  groupThemePackages: () => [],
  usableThemeCatalog: () => false,
  managedThemeDefinition: () => null,
}));
vi.mock("@/hooks/useThemeMarketplace", () => ({
  useThemeMarketplace: () => ({
    catalog: {},
    inventory: {
      data: [
        mocks.damaged
          ? {
              id: "damaged",
              name: "Damaged",
              version: "1.0.0",
              active: false,
              theme: null,
              error: "immutable payload changed",
              error_code: "MANAGED_THEME_INVALID",
            }
          : { id: "midnight", name: "Midnight", version: "1.0.0", active: true, theme: {} },
      ],
    },
    refresh: {},
    mutation: { mutate: mocks.mutate },
    recovery: {},
  }),
}));

describe("marketplace displayed theme versus saved references", () => {
  beforeEach(() => {
    mocks.themeId = "cadencr-dark";
    mocks.mutate.mockReset();
    mocks.damaged = false;
  });
  it("shows corruption and permits confirmed removal, but never applies or duplicates it", () => {
    mocks.damaged = true;
    render(<ThemeMarketplace />);
    expect(screen.getByText(/immutable payload changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate theme" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Duplicate to author project" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove theme…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal and built-in fallback" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { kind: "remove", id: "damaged", confirmFallback: true },
      expect.any(Object),
    );
  });
  it("allows activating a theme referenced only by the dark system slot in manual mode", () => {
    render(<ThemeMarketplace />);
    expect(screen.getByText(/Saved selection/)).toBeInTheDocument();
    const activate = screen.getByRole("button", { name: "Activate theme" });
    expect(activate).toBeEnabled();
    fireEvent.click(activate);
    expect(mocks.mutate).toHaveBeenCalledWith({ kind: "apply", id: "midnight" });
    fireEvent.click(screen.getByRole("button", { name: "Remove theme…" }));
    expect(screen.getByText(/Any manual or system selection/)).toBeInTheDocument();
  });
  it("disables activation only when actually displayed, including follow-system resolution", () => {
    mocks.themeId = "managed:midnight";
    const view = render(<ThemeMarketplace />);
    expect(screen.getByRole("button", { name: "Theme active" })).toBeDisabled();
    mocks.themeId = "cadencr-light";
    view.rerender(<ThemeMarketplace />);
    expect(screen.getByRole("button", { name: "Activate theme" })).toBeEnabled();
  });
});
