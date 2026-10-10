// @vitest-environment jsdom
// Pinned to jsdom: asserts computed colors, which happy-dom does not normalize to rgb().
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CADENCR_THEME_LOGOS } from "@/lib/themes/logos";
import { NO_TEXTURE, type ThemeTexture } from "@/lib/themes/chrome";
import type { ThemeDefinition } from "@/lib/themes";
import { AmbientBackground } from "./AmbientBackground";

const PAUSED_ATTR = "data-ambient-paused";

let texture: ThemeTexture = NO_TEXTURE;
let assets: Record<string, string> = {};

vi.mock("@/hooks/useTheme", () => ({
  useTheme: (): { theme: ThemeDefinition } => ({
    theme: {
      id: "user:mine",
      label: "Mine",
      appearance: "dark",
      logo: CADENCR_THEME_LOGOS.dark,
      chrome: { chassis: "flat", tabs: "underline", texture },
      assets,
      swatch: { background: "#000", foreground: "#fff", primary: "#f0f", accent: "#0ff" },
      xterm: {} as ThemeDefinition["xterm"],
    },
  }),
}));

const HALO = {
  color: "#5fb3e0",
  size: 72,
  x: 28,
  y: 32,
  blur: 80,
  opacity: 0.5,
  drift: 28,
};

let focused = true;

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

function isPaused(): boolean {
  return document.documentElement.hasAttribute(PAUSED_ATTR);
}

describe("AmbientBackground", () => {
  beforeEach(() => {
    focused = true;
    setHidden(false);
    texture = { ...NO_TEXTURE, halos: [HALO] };
    assets = {};
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(PAUSED_ATTR);
    vi.restoreAllMocks();
  });

  describe("what the theme asked for", () => {
    it("renders nothing at all for a theme with no texture", () => {
      texture = NO_TEXTURE;
      const { container } = render(<AmbientBackground />);

      expect(container).toBeEmptyDOMElement();
      // Not even the visibility listener: a theme with no texture has no
      // animation to pause, so it must cost nothing.
      expect(isPaused()).toBe(false);
      focused = false;
      window.dispatchEvent(new Event("blur"));
      expect(isPaused()).toBe(false);
    });

    it("renders one halo per declared halo, positioned by its centre", () => {
      texture = { ...NO_TEXTURE, halos: [HALO, { ...HALO, x: 79, size: 66 }] };
      const { container } = render(<AmbientBackground />);

      const halos = container.querySelectorAll<HTMLElement>(".halo");
      expect(halos).toHaveLength(2);
      expect(halos[0].style.left).toBe("28%");
      expect(halos[0].style.width).toBe("72vw");
      // Pulled back by half its size on each axis, because `transform` belongs
      // to the drift animation.
      expect(halos[0].style.marginLeft).toBe("-36vw");
      expect(halos[1].style.left).toBe("79%");
      expect(halos[1].style.marginLeft).toBe("-33vw");
    });

    it("gives consecutive halos different drift paths, and a still halo none", () => {
      texture = {
        ...NO_TEXTURE,
        halos: [HALO, HALO, HALO, HALO, { ...HALO, drift: 0 }],
      };
      const { container } = render(<AmbientBackground />);

      const names = [...container.querySelectorAll<HTMLElement>(".halo")].map(
        (halo) => halo.style.animationName,
      );
      expect(names.slice(0, 4)).toEqual([
        "cadencr-drift-1",
        "cadencr-drift-2",
        "cadencr-drift-3",
        "cadencr-drift-1",
      ]);
      expect(names[4]).toBe("");
    });

    it("paints grain in the theme's own color, masked by the noise", () => {
      texture = {
        ...NO_TEXTURE,
        grain: { color: "#9ea8c7", opacity: 0.36, blend: "screen", scale: 180 },
      };
      const { container } = render(<AmbientBackground />);

      const grain = container.querySelector<HTMLElement>(".grain");
      expect(grain?.style.backgroundColor).toBe("rgb(158, 168, 199)");
      expect(grain?.style.maskSize).toBe("180px");
      expect(grain?.style.mixBlendMode).toBe("screen");
    });

    it("omits the veil unless the theme asked for one", () => {
      const { container: without } = render(<AmbientBackground />);
      expect(without.querySelector(".ambient-veil")).toBeNull();

      cleanup();
      texture = { ...NO_TEXTURE, halos: [HALO], veil: true };
      const { container: with_ } = render(<AmbientBackground />);
      expect(with_.querySelector(".ambient-veil")).not.toBeNull();
    });
  });

  describe("image assets", () => {
    const image = {
      asset: "paper.png",
      opacity: 0.2,
      blend: "multiply" as const,
      fit: "tile" as const,
      scale: 320,
    };

    it("paints the data URL the backend read out of the theme's folder", () => {
      texture = { ...NO_TEXTURE, image };
      assets = { "paper.png": "data:image/png;base64,AAAA" };
      const { container } = render(<AmbientBackground />);

      const layer = container.querySelector<HTMLElement>(".texture-image");
      expect(layer?.style.backgroundImage).toBe('url("data:image/png;base64,AAAA")');
      expect(layer?.style.backgroundSize).toBe("320px");
      expect(layer?.style.backgroundRepeat).toBe("repeat");
    });

    it("scales rather than tiles when the theme says cover", () => {
      texture = { ...NO_TEXTURE, image: { ...image, fit: "cover" } };
      assets = { "paper.png": "data:image/png;base64,AAAA" };
      const { container } = render(<AmbientBackground />);

      const layer = container.querySelector<HTMLElement>(".texture-image");
      expect(layer?.style.backgroundSize).toBe("cover");
      expect(layer?.style.backgroundRepeat).toBe("no-repeat");
    });

    it("skips the layer when the file never arrived, rather than painting a broken url", () => {
      texture = { ...NO_TEXTURE, halos: [HALO], image };
      assets = {};
      const { container } = render(<AmbientBackground />);

      expect(container.querySelector(".texture-image")).toBeNull();
      expect(container.querySelector(".halo")).not.toBeNull();
    });
  });

  describe("drift gating", () => {
    it("does not pause the halo drift while the window is visible and focused", () => {
      render(<AmbientBackground />);
      expect(isPaused()).toBe(false);
    });

    it("pauses on blur and resumes on focus", () => {
      render(<AmbientBackground />);

      focused = false;
      window.dispatchEvent(new Event("blur"));
      expect(isPaused()).toBe(true);

      focused = true;
      window.dispatchEvent(new Event("focus"));
      expect(isPaused()).toBe(false);
    });

    it("pauses when the window is hidden", () => {
      render(<AmbientBackground />);

      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(isPaused()).toBe(true);
    });

    it("clears the paused state and stops reacting after unmount", () => {
      const { unmount } = render(<AmbientBackground />);

      focused = false;
      window.dispatchEvent(new Event("blur"));
      expect(isPaused()).toBe(true);

      unmount();
      expect(isPaused()).toBe(false);

      // Listeners are gone: further events must not re-add the attribute.
      window.dispatchEvent(new Event("blur"));
      expect(isPaused()).toBe(false);
    });
  });
});
