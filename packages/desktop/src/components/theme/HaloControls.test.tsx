import { cleanup, render, screen, within } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTheme, type ThemeId } from "@/lib/themes";
import { DEFAULT_HALO_OVERRIDE, type HaloOverride } from "@/lib/themes/halo-override";
import { HaloControls } from "./HaloControls";

const mockSetOverride = vi.fn();
const mockReset = vi.fn();

const mockState = vi.hoisted(() => ({
  themeId: "frost-dark" as ThemeId,
  // Spelled out rather than spread from `DEFAULT_HALO_OVERRIDE`: `vi.hoisted`
  // runs before the imports are evaluated.
  override: { rotation: 0, intensity: 1, colors: [], motion: "still", speed: 4 } as HaloOverride,
  isSaving: false,
  error: null as string | null,
}));

vi.mock("@/hooks/useHaloOverride", () => ({
  useHaloOverride: () => ({
    override: mockState.override,
    setOverride: mockSetOverride,
    reset: mockReset,
    error: mockState.error,
    isLoading: false,
    isSaving: mockState.isSaving,
  }),
}));

// The palette is read off the live document, which jsdom does not resolve
// custom properties for. `halo-palette.test.ts` covers the read itself.
const mockReadHaloPalette = vi.hoisted(() =>
  vi.fn(() => [
    { token: "--acc-cyan", color: "#22d3ee" },
    { token: "--acc-pink", color: "#f472b6" },
  ]),
);

vi.mock("@/lib/themes/halo-palette", () => ({
  readHaloPalette: mockReadHaloPalette,
}));

function renderPanel(): ReturnType<typeof render> {
  return render(<HaloControls theme={getTheme(mockState.themeId)} isLoading={false} />);
}

/** The panel is collapsed by default; every assertion below needs it open. */
async function openPanel(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /halos/i }));
}

describe("HaloControls", () => {
  beforeEach(() => {
    mockState.themeId = "frost-dark";
    mockState.override = { ...DEFAULT_HALO_OVERRIDE };
    mockState.isSaving = false;
    mockState.error = null;
    mockSetOverride.mockClear();
    mockReset.mockClear();
    mockReadHaloPalette.mockClear();
  });

  describe("compatibility", () => {
    it("renders nothing for a theme that declares no halos", () => {
      mockState.themeId = "dracula";
      const { container } = renderPanel();

      expect(container).toBeEmptyDOMElement();
    });

    it("renders for a theme that declares halos", () => {
      renderPanel();

      expect(screen.getByRole("button", { name: /halos/i })).toBeInTheDocument();
    });

    it("counts the halos the theme declares", () => {
      renderPanel();

      // Frost Dark declares a top glow plus three drifting fields.
      expect(screen.getByRole("button", { name: /halos/i })).toHaveTextContent("4");
    });
  });

  describe("the panel", () => {
    it("stays collapsed until asked", () => {
      renderPanel();

      expect(screen.queryByLabelText("Orientation")).not.toBeInTheDocument();
    });

    it("opens on the header and shows one color row per halo", async () => {
      renderPanel();
      await openPanel();

      expect(screen.getByLabelText("Orientation")).toBeInTheDocument();
      expect(screen.getByLabelText("Intensity")).toBeInTheDocument();
      for (const index of [1, 2, 3, 4]) {
        expect(screen.getByRole("button", { name: `Halo ${index} color` })).toBeInTheDocument();
      }
    });

    it("says the theme file is left alone", async () => {
      renderPanel();
      await openPanel();

      expect(screen.getByText(/theme file is left untouched/i)).toBeInTheDocument();
    });
  });

  describe("the controls", () => {
    it("writes a rotation without disturbing the rest of the override", async () => {
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, intensity: 1.4, colors: ["#94e2d5"] };
      renderPanel();
      await openPanel();

      const slider = screen.getByLabelText("Orientation");
      slider.focus();
      await userEvent.keyboard("{ArrowRight}");

      expect(mockSetOverride).toHaveBeenCalledWith({
        ...DEFAULT_HALO_OVERRIDE,
        rotation: 5,
        intensity: 1.4,
        colors: ["#94e2d5"],
      });
    });

    it("writes an intensity without disturbing the rest of the override", async () => {
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, rotation: -20 };
      renderPanel();
      await openPanel();

      const slider = screen.getByLabelText("Intensity");
      slider.focus();
      await userEvent.keyboard("{ArrowRight}");

      expect(mockSetOverride).toHaveBeenCalledWith({
        ...DEFAULT_HALO_OVERRIDE,
        rotation: -20,
        intensity: 1.05,
      });
    });

    it("offers every motion, with the current one checked", async () => {
      renderPanel();
      await openPanel();

      for (const label of ["Still", "Circular", "Lava lamp", "Glowing"]) {
        expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
      }
      expect(screen.getByRole("radio", { name: "Still" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Lava lamp" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    it("picks a motion without disturbing the rest of the override", async () => {
      const user = userEvent.setup();
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, rotation: 30, intensity: 1.2 };
      renderPanel();
      await openPanel();

      await user.click(screen.getByRole("radio", { name: "Lava lamp" }));

      expect(mockSetOverride).toHaveBeenCalledWith({
        ...DEFAULT_HALO_OVERRIDE,
        rotation: 30,
        intensity: 1.2,
        motion: "lava",
      });
    });

    it("writes a pace without disturbing the rest of the override", async () => {
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, motion: "orbit" };
      renderPanel();
      await openPanel();

      const slider = screen.getByLabelText("Speed");
      slider.focus();
      await userEvent.keyboard("{ArrowRight}");

      expect(mockSetOverride).toHaveBeenCalledWith({
        ...DEFAULT_HALO_OVERRIDE,
        motion: "orbit",
        speed: 5,
      });
    });

    it("greys out the angle as soon as the field moves, and the pace while it is still", async () => {
      renderPanel();
      await openPanel();

      expect(screen.getByLabelText("Orientation")).not.toHaveAttribute("aria-disabled");
      expect(screen.getByLabelText("Speed")).toHaveAttribute("aria-disabled", "true");

      for (const motion of ["orbit", "lava", "glow"] as const) {
        cleanup();
        mockState.override = { ...DEFAULT_HALO_OVERRIDE, motion };
        renderPanel();
        await openPanel();

        expect(screen.getByLabelText("Orientation")).toHaveAttribute("aria-disabled", "true");
        expect(screen.getByLabelText("Speed")).not.toHaveAttribute("aria-disabled");
      }
    });

    it("prints the pace in the unit the current motion uses", async () => {
      renderPanel();
      await openPanel();
      expect(screen.getByText("—")).toBeInTheDocument();

      for (const [motion, label] of [
        ["orbit", "4°/s"],
        // The pace is 4, but the blobs travel at 4 × 0.35 vw/s.
        ["lava", "1.4 vw/s"],
        ["glow", "10.0s"],
      ] as const) {
        cleanup();
        mockState.override = { ...DEFAULT_HALO_OVERRIDE, motion };
        renderPanel();
        await openPanel();
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });
  });

  describe("colors", () => {
    it("shows the theme's own color until one is picked", async () => {
      renderPanel();
      await openPanel();

      const row = screen.getByRole("button", { name: "Halo 1 color" });
      expect(within(row).getByText("theme")).toBeInTheDocument();
    });

    it("marks a halo whose color was picked", async () => {
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, colors: ["#94e2d5"] };
      renderPanel();
      await openPanel();

      const row = screen.getByRole("button", { name: "Halo 1 color" });
      expect(within(row).getByText("custom")).toBeInTheDocument();
    });

    it("picks a color from the theme's own palette", async () => {
      const user = userEvent.setup();
      renderPanel();
      await openPanel();

      await user.click(screen.getByRole("button", { name: "Halo 2 color" }));
      await user.click(screen.getByRole("button", { name: "Halo 2: --acc-cyan" }));

      expect(mockSetOverride).toHaveBeenCalledWith({
        ...DEFAULT_HALO_OVERRIDE,
        colors: [null, "#22d3ee"],
      });
    });

    it("marks the swatch the halo currently wears", async () => {
      const user = userEvent.setup();
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, colors: ["#22d3ee"] };
      renderPanel();
      await openPanel();

      await user.click(screen.getByRole("button", { name: "Halo 1 color" }));

      expect(screen.getByRole("button", { name: "Halo 1: --acc-cyan" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Halo 1: --acc-pink" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("clears a picked color back to the theme's", async () => {
      const user = userEvent.setup();
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, colors: ["#94e2d5"] };
      renderPanel();
      await openPanel();

      await user.click(screen.getByRole("button", { name: "Halo 1 color" }));
      await user.click(screen.getByRole("button", { name: /use the theme's color/i }));

      expect(mockSetOverride).toHaveBeenCalledWith({
        ...DEFAULT_HALO_OVERRIDE,
        colors: [null],
      });
    });

    it("reads the palette when a row opens, not while rendering", async () => {
      const user = userEvent.setup();
      renderPanel();
      await openPanel();

      // The active theme reaches <html> from an effect that runs after this
      // component renders, so a render-time read would hand back the previous
      // theme's tokens.
      expect(mockReadHaloPalette).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Halo 1 color" }));
      expect(mockReadHaloPalette).toHaveBeenCalledTimes(1);
    });
  });

  describe("reset", () => {
    it("is offered only once something is tuned", async () => {
      renderPanel();
      expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
    });

    it("appears for a tuned theme and resets it", async () => {
      const user = userEvent.setup();
      mockState.override = { ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 };
      renderPanel();

      await user.click(screen.getByRole("button", { name: /reset/i }));

      expect(mockReset).toHaveBeenCalled();
    });
  });

  describe("status", () => {
    it("announces a write in flight", async () => {
      mockState.isSaving = true;
      renderPanel();
      await openPanel();

      expect(screen.getByRole("status")).toHaveTextContent(/saving/i);
    });

    it("says nothing once the write lands", async () => {
      renderPanel();
      await openPanel();

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("says why a stored tuning could not be read", async () => {
      mockState.error = "an object keyed by theme id";
      renderPanel();
      await openPanel();

      expect(screen.getByRole("alert")).toHaveTextContent(/could not read/i);
    });
  });
});
