import { render, screen, within } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeDrawer } from "./ThemeDrawer";
import {
  DEFAULT_HALO_OVERRIDE,
  DEFAULT_SYSTEM_DARK_THEME_ID,
  DEFAULT_SYSTEM_LIGHT_THEME_ID,
  getTheme,
} from "@/lib/themes";

const mockSetTheme = vi.fn();
const mockSetFollowSystemTheme = vi.fn();
const mockSetSystemLightTheme = vi.fn();
const mockSetSystemDarkTheme = vi.fn();
const mockNavigate = vi.fn();

const mockState = vi.hoisted(() => ({
  followSystemTheme: false,
  isOpen: true,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => {
    const fakeRouterState = {
      location: {
        search: mockState.isOpen ? { "theme-selector": true } : {},
      },
    };
    return select(fakeRouterState);
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    themeId: mockState.followSystemTheme ? DEFAULT_SYSTEM_LIGHT_THEME_ID : "dracula",
    // Dracula declares no texture, so the halo panel stays out of the way here;
    // `HaloControls.test.tsx` covers the themes that do have one.
    theme: getTheme("dracula"),
    manualThemeId: "dracula",
    systemLightThemeId: DEFAULT_SYSTEM_LIGHT_THEME_ID,
    systemDarkThemeId: DEFAULT_SYSTEM_DARK_THEME_ID,
    followSystemTheme: mockState.followSystemTheme,
    setTheme: mockSetTheme,
    setFollowSystemTheme: mockSetFollowSystemTheme,
    setSystemLightTheme: mockSetSystemLightTheme,
    setSystemDarkTheme: mockSetSystemDarkTheme,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useHaloOverride", () => ({
  useHaloOverride: () => ({
    override: DEFAULT_HALO_OVERRIDE,
    setOverride: vi.fn(),
    reset: vi.fn(),
    isLoading: false,
    isSaving: false,
  }),
}));

describe("ThemeDrawer", () => {
  beforeEach(() => {
    mockState.followSystemTheme = false;
    mockState.isOpen = true;
    mockSetTheme.mockClear();
    mockSetFollowSystemTheme.mockClear();
    mockSetSystemLightTheme.mockClear();
    mockSetSystemDarkTheme.mockClear();
    mockNavigate.mockClear();
  });

  it("renders nothing when the URL search param is absent", () => {
    mockState.isOpen = false;

    render(<ThemeDrawer />);

    expect(screen.queryByRole("dialog", { name: /change theme/i })).not.toBeInTheDocument();
  });

  it("shows one all-UI theme picker when follow-system is off", () => {
    render(<ThemeDrawer />);

    expect(screen.getByRole("switch", { name: /follow system theme/i })).not.toBeChecked();
    expect(screen.getByText("All UI theme")).toBeInTheDocument();
    expect(screen.queryByText("Light system theme")).not.toBeInTheDocument();
    expect(screen.queryByText("Dark system theme")).not.toBeInTheDocument();
  });

  it("shows separate light and dark pickers when follow-system is on", () => {
    mockState.followSystemTheme = true;

    render(<ThemeDrawer />);

    expect(screen.getByRole("switch", { name: /follow system theme/i })).toBeChecked();
    expect(screen.getByText("Light system theme")).toBeInTheDocument();
    expect(screen.getByText("Dark system theme")).toBeInTheDocument();
    expect(screen.queryByText("All UI theme")).not.toBeInTheDocument();
  });

  it("allows any theme to be selected for either system appearance", () => {
    mockState.followSystemTheme = true;

    render(<ThemeDrawer />);

    const lightPicker = screen.getByRole("radiogroup", { name: "Light system theme" });
    const darkPicker = screen.getByRole("radiogroup", { name: "Dark system theme" });

    expect(within(lightPicker).getByRole("radio", { name: /dracula/i })).toBeInTheDocument();
    expect(within(lightPicker).getByRole("radio", { name: /aurora/i })).toBeInTheDocument();
    expect(within(darkPicker).getByRole("radio", { name: /dracula/i })).toBeInTheDocument();
    expect(within(darkPicker).getByRole("radio", { name: /aurora/i })).toBeInTheDocument();
  });

  it("persists the follow-system toggle through the theme hook", async () => {
    const user = userEvent.setup();

    render(<ThemeDrawer />);
    await user.click(screen.getByRole("switch", { name: /follow system theme/i }));

    expect(mockSetFollowSystemTheme).toHaveBeenCalledWith(true);
  });

  it("strips theme-selector from the URL on close button click", async () => {
    const user = userEvent.setup();

    render(<ThemeDrawer />);
    await user.click(screen.getByRole("button", { name: /close theme picker/i }));

    expect(mockNavigate).toHaveBeenCalled();
    const arg = mockNavigate.mock.calls[0]?.[0];
    expect(arg.to).toBe(".");
    // search is a function that maps prev → next
    const reducer = arg.search as (prev: Record<string, unknown>) => Record<string, unknown>;
    expect(reducer({ "theme-selector": true, cwd: "/x" })).toEqual({ cwd: "/x" });
  });

  it("strips theme-selector from the URL on Escape", async () => {
    const user = userEvent.setup();

    render(<ThemeDrawer />);
    await user.keyboard("{Escape}");

    expect(mockNavigate).toHaveBeenCalled();
  });

  it("navigates through themes with arrow keys", async () => {
    const user = userEvent.setup();

    render(<ThemeDrawer />);
    const picker = screen.getByRole("radiogroup", { name: "All UI theme" });
    picker.focus();
    await user.keyboard("{ArrowRight}");

    expect(mockSetTheme).toHaveBeenCalledTimes(1);
  });
});
