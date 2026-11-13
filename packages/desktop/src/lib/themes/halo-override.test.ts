import { describe, expect, it } from "vitest";
import type { ThemeHalo, ThemeTexture } from "./chrome";
import { NO_TEXTURE } from "./chrome";
import {
  colorAlpha,
  DEFAULT_HALO_OVERRIDE,
  INTENSITY_RANGE,
  isDefaultOverride,
  glowSeconds,
  lavaSpeed,
  orbitSeconds,
  overrideFor,
  parseHaloOverrides,
  resolveHalo,
  resolveTextureHalos,
  ROTATION_RANGE,
  SPEED_RANGE,
  withOverride,
  type HaloOverride,
  type HaloOverrideMap,
} from "./halo-override";

const HALO: ThemeHalo = {
  color: "#5fb3e0",
  size: 72,
  x: 28,
  y: 32,
  blur: 80,
  opacity: 0.5,
  drift: 28,
};

function override(patch: Partial<HaloOverride> = {}): HaloOverride {
  return { ...DEFAULT_HALO_OVERRIDE, ...patch };
}

/** The map a raw setting parses to, or `{}` when it does not parse. */
function parseMap(raw: string | null): HaloOverrideMap {
  return parseHaloOverrides(raw).value ?? {};
}

/** One theme's entry, asserting it is there. */
function entry(map: HaloOverrideMap, themeId: string): HaloOverride {
  const found = map[themeId as keyof HaloOverrideMap];
  if (!found) throw new Error(`no override for ${themeId}`);
  return found;
}

function texture(halos: ThemeHalo[]): ThemeTexture {
  return { ...NO_TEXTURE, halos };
}

describe("colorAlpha", () => {
  it("reads the alpha out of every syntax the theme validator accepts", () => {
    expect(colorAlpha("#cba6f7")).toBe(1);
    expect(colorAlpha("#cba6f7b8")).toBeCloseTo(0.722, 3);
    expect(colorAlpha("#fff8")).toBeCloseTo(0.533, 3);
    expect(colorAlpha("oklch(0.6 0.12 230 / 0.55)")).toBeCloseTo(0.55, 5);
    expect(colorAlpha("rgb(1 2 3 / 40%)")).toBeCloseTo(0.4, 5);
    expect(colorAlpha("rgba(1, 2, 3, 0.25)")).toBeCloseTo(0.25, 5);
    expect(colorAlpha("hsla(1, 2%, 3%, 0.75)")).toBeCloseTo(0.75, 5);
    expect(colorAlpha("transparent")).toBe(0);
  });

  it("treats anything it cannot read as opaque rather than fading the halo", () => {
    expect(colorAlpha("rebeccapurple")).toBe(1);
    expect(colorAlpha("not-a-color")).toBe(1);
    expect(colorAlpha("rgb(1 2 3 / nope)")).toBe(1);
  });
});

describe("resolveHalo", () => {
  it("leaves a halo untouched when nothing is tuned", () => {
    expect(resolveHalo(HALO, DEFAULT_HALO_OVERRIDE, 0)).toEqual(HALO);
  });

  it("multiplies opacity by the intensity and clamps at opaque", () => {
    expect(resolveHalo(HALO, override({ intensity: 1.5 }), 0).opacity).toBeCloseTo(0.75, 5);
    expect(resolveHalo(HALO, override({ intensity: 2 }), 0).opacity).toBe(1);
    expect(resolveHalo(HALO, override({ intensity: 0 }), 0).opacity).toBe(0);
  });

  it("rotates the center around the viewport center", () => {
    // A quarter turn takes (28, 32) — 22 left of and 18 above center — to
    // (68, 28): 18 right of and 22 above center.
    const turned = resolveHalo(HALO, override({ rotation: 90 }), 0);
    expect(turned.x).toBeCloseTo(68, 5);
    expect(turned.y).toBeCloseTo(28, 5);
  });

  it("returns the halo to its own position after a full turn", () => {
    const turned = resolveHalo(HALO, override({ rotation: 180 }), 0);
    expect(turned.x).toBeCloseTo(72, 5);
    expect(turned.y).toBeCloseTo(68, 5);
  });

  it("keeps the theme's alpha when the picked color is opaque", () => {
    const halo = { ...HALO, color: "#cba6f7b8" };
    const resolved = resolveHalo(halo, override({ colors: ["#94e2d5"] }), 0);

    // The picked color is opaque, so it is re-emitted at the theme's 73% rather
    // than jumping the halo's strength by a third.
    expect(resolved.color).toBe("color-mix(in srgb, #94e2d5 72.16%, transparent)");
  });

  it("honours a picked color that is itself translucent", () => {
    const resolved = resolveHalo(HALO, override({ colors: ["#94e2d580"] }), 0);
    expect(resolved.color).toBe("#94e2d580");
  });

  it("leaves the color alone for an index the override does not name", () => {
    const resolved = resolveHalo(HALO, override({ colors: [null, "#94e2d5"] }), 0);
    expect(resolved.color).toBe(HALO.color);
  });

  it("does not touch size, blur or drift", () => {
    const resolved = resolveHalo(HALO, override({ rotation: 45, intensity: 1.4 }), 0);
    expect(resolved.size).toBe(HALO.size);
    expect(resolved.blur).toBe(HALO.blur);
    expect(resolved.drift).toBe(HALO.drift);
  });

  it("drops the fixed angle as soon as the field moves", () => {
    // A moving field has no fixed angle: adding a static one on top would make
    // the motion start from a position the panel no longer lets anyone see.
    for (const motion of ["orbit", "lava", "glow"] as const) {
      const moving = resolveHalo(HALO, override({ rotation: 90, motion }), 0);
      expect(moving.x).toBe(HALO.x);
      expect(moving.y).toBe(HALO.y);
    }
  });
});

describe("the pace, per motion", () => {
  it("is null for every motion that does not use it", () => {
    expect(orbitSeconds(DEFAULT_HALO_OVERRIDE)).toBeNull();
    expect(glowSeconds(DEFAULT_HALO_OVERRIDE)).toBeNull();
    expect(lavaSpeed(DEFAULT_HALO_OVERRIDE)).toBeNull();

    expect(orbitSeconds(override({ motion: "glow" }))).toBeNull();
    expect(glowSeconds(override({ motion: "orbit" }))).toBeNull();
    expect(lavaSpeed(override({ motion: "orbit" }))).toBeNull();
  });

  it("turns the pace into seconds per turn for the orbit", () => {
    expect(orbitSeconds(override({ motion: "orbit", speed: 4 }))).toBe(90);
    expect(orbitSeconds(override({ motion: "orbit", speed: 18 }))).toBe(20);
    expect(orbitSeconds(override({ motion: "orbit", speed: 1 }))).toBe(360);
  });

  it("turns the pace into seconds per breath for the glow", () => {
    expect(glowSeconds(override({ motion: "glow", speed: 4 }))).toBe(10);
    expect(glowSeconds(override({ motion: "glow", speed: 1 }))).toBe(40);
    // 40 / 18 would pulse twice a second, which reads as a flicker.
    expect(glowSeconds(override({ motion: "glow", speed: 18 }))).toBe(3);
  });

  it("turns the pace into travel speed for the lava lamp", () => {
    expect(lavaSpeed(override({ motion: "lava", speed: 4 }))).toBeCloseTo(1.4, 5);
    expect(lavaSpeed(override({ motion: "lava", speed: 18 }))).toBeCloseTo(6.3, 5);
  });
});

describe("resolveTextureHalos", () => {
  it("returns the very same texture when the override leaves every halo alone", () => {
    const source = texture([HALO]);
    expect(resolveTextureHalos(source, DEFAULT_HALO_OVERRIDE)).toBe(source);
    // A motion or pace change cannot alter a halo, so it must not break the
    // layer memo either.
    expect(resolveTextureHalos(source, override({ motion: "lava", speed: 12 }))).toBe(source);
  });

  it("returns the very same texture for a theme with no halos", () => {
    const source = texture([]);
    expect(resolveTextureHalos(source, override({ intensity: 1.5 }))).toBe(source);
  });

  it("resolves every halo and leaves the other layers alone", () => {
    const grain = { color: "#9ea8c7", opacity: 0.36, blend: "screen" as const, scale: 180 };
    const source: ThemeTexture = {
      ...texture([HALO, { ...HALO, x: 79, y: 61 }]),
      base: "#141826",
      grain,
      veil: true,
    };
    const resolved = resolveTextureHalos(source, override({ intensity: 1.5 }));

    expect(resolved.halos).toHaveLength(2);
    expect(resolved.halos[0].opacity).toBeCloseTo(0.75, 5);
    expect(resolved.halos[1].opacity).toBeCloseTo(0.75, 5);
    expect(resolved.base).toBe(source.base);
    expect(resolved.grain).toBe(grain);
    expect(resolved.veil).toBe(true);
  });
});

describe("parseHaloOverrides", () => {
  it("reads an empty setting as no overrides", () => {
    expect(parseMap(null)).toEqual({});
    expect(parseMap("")).toEqual({});
  });

  it("reads a hand-edited setting that no longer parses as no overrides", () => {
    expect(parseMap("{not json")).toEqual({});
    expect(parseMap("[]")).toEqual({});
    expect(parseMap("null")).toEqual({});
  });

  it("says why a setting it could not read was rejected", () => {
    expect(parseHaloOverrides("{not json").error).not.toBeNull();
    expect(parseHaloOverrides("[]").error).toMatch(/theme id/);
    // An unset setting is not an error.
    expect(parseHaloOverrides(null).error).toBeNull();
  });

  it("round-trips what it wrote", () => {
    const map = { "frost-dark": override({ rotation: -12, intensity: 1.3 }) };
    expect(parseMap(JSON.stringify(map))).toEqual(map);
  });

  it("clamps a value outside the range the panel can produce", () => {
    const parsed = parseMap(
      JSON.stringify({ "frost-dark": { rotation: 900, intensity: 12, colors: [] } }),
    );
    expect(entry(parsed, "frost-dark").rotation).toBe(ROTATION_RANGE.max);
    expect(entry(parsed, "frost-dark").intensity).toBe(INTENSITY_RANGE.max);
  });

  it("falls back per field rather than dropping the whole entry", () => {
    const parsed = parseMap(
      JSON.stringify({ "frost-dark": { rotation: "sideways", intensity: 1.4 } }),
    );
    expect(entry(parsed, "frost-dark").rotation).toBe(DEFAULT_HALO_OVERRIDE.rotation);
    expect(entry(parsed, "frost-dark").intensity).toBe(1.4);
  });

  it("drops color slots that are not colors", () => {
    const parsed = parseMap(JSON.stringify({ "frost-dark": { colors: ["#fff", 42, "", null] } }));
    expect(entry(parsed, "frost-dark").colors).toEqual(["#fff", null, null, null]);
  });

  it("reads the motion, and defaults it to still for an entry written before it existed", () => {
    const parsed = parseMap(
      JSON.stringify({
        "frost-dark": { rotation: 0, intensity: 1, colors: [] },
        "frost-light": { motion: "lava", speed: 9 },
      }),
    );
    expect(entry(parsed, "frost-dark").motion).toBe("still");
    expect(entry(parsed, "frost-dark").speed).toBe(DEFAULT_HALO_OVERRIDE.speed);
    expect(entry(parsed, "frost-light").motion).toBe("lava");
    expect(entry(parsed, "frost-light").speed).toBe(9);
  });

  it("ignores a motion it does not know", () => {
    const parsed = parseMap(JSON.stringify({ "frost-dark": { motion: "spin" } }));
    expect(entry(parsed, "frost-dark").motion).toBe("still");
  });

  it("clamps a speed outside the range the panel can produce", () => {
    const parsed = parseMap(JSON.stringify({ "frost-dark": { speed: 900 } }));
    expect(entry(parsed, "frost-dark").speed).toBe(SPEED_RANGE.max);
  });
});

describe("withOverride", () => {
  it("stores an override that asks for something", () => {
    const map = withOverride({}, "frost-dark", override({ intensity: 1.5 }));
    expect(entry(map, "frost-dark").intensity).toBe(1.5);
  });

  it("removes the entry when the override is back to the default", () => {
    const map = withOverride({ "frost-dark": override({ intensity: 1.5 }) }, "frost-dark", {
      ...DEFAULT_HALO_OVERRIDE,
    });
    expect(map).toEqual({});
  });

  it("returns the same map when there is nothing to remove", () => {
    const source = {};
    expect(withOverride(source, "frost-dark", DEFAULT_HALO_OVERRIDE)).toBe(source);
  });

  it("keeps other themes' overrides", () => {
    const source = { "frost-light": override({ rotation: 30 }) };
    const map = withOverride(source, "frost-dark", override({ intensity: 1.2 }));
    expect(entry(map, "frost-light").rotation).toBe(30);
    expect(entry(map, "frost-dark").intensity).toBe(1.2);
  });
});

describe("isDefaultOverride", () => {
  it("treats a color slot of null as untuned", () => {
    expect(isDefaultOverride(override({ colors: [null, null] }))).toBe(true);
    expect(isDefaultOverride(override({ colors: [null, "#fff"] }))).toBe(false);
  });

  it("counts a motion or a pace as tuning", () => {
    expect(isDefaultOverride(override({ motion: "orbit" }))).toBe(false);
    expect(isDefaultOverride(override({ speed: 9 }))).toBe(false);
  });
});

describe("overrideFor", () => {
  it("falls back to the default for a theme that was never tuned", () => {
    expect(overrideFor({}, "frost-dark")).toBe(DEFAULT_HALO_OVERRIDE);
  });
});
