import { describe, expect, it } from "vitest";
import { chromeOf, NO_TEXTURE } from "./chrome";
import { FROST_DARK_THEME } from "./frost-dark";
import { haloCount, halosEnabled, halosFor, usesFallbackTexture } from "./halo-composition";
import { DEFAULT_HALO_OVERRIDE, resolveTextureHalos } from "./halo-override";
import { FROST_GRAIN } from "./texture-material";

const frost = chromeOf(FROST_DARK_THEME).texture;

describe("user halo compositions", () => {
  it("keeps authored fields enabled and other themes off until explicitly enabled", () => {
    expect(halosEnabled(frost)).toBe(true);
    expect(halosEnabled(NO_TEXTURE)).toBe(false);
    expect(halosEnabled(frost, false)).toBe(false);
    expect(halosEnabled(NO_TEXTURE, true)).toBe(true);
    expect(haloCount(NO_TEXTURE)).toBe(3);
    expect(haloCount(frost)).toBe(frost.halos.length);
  });

  it("bounds the requested count to one through ten", () => {
    expect(haloCount(NO_TEXTURE, 0)).toBe(1);
    expect(haloCount(NO_TEXTURE, 99)).toBe(10);
    expect(haloCount(NO_TEXTURE, 3.7)).toBe(4);
  });

  it("shares Frost geometry and material while retaining the active palette", () => {
    const added = halosFor(NO_TEXTURE);
    added.forEach((halo, index) => {
      const authored = frost.halos[index + 1];
      expect(halo).toMatchObject({
        x: authored.x,
        y: authored.y,
        size: authored.size,
        drift: authored.drift,
        blur: authored.blur,
        opacity: authored.opacity,
      });
      expect(halo.color).toContain(`var(--chart-${index + 1}`);
    });
  });

  it("retains authored slots and keeps extra slots stable when changing count", () => {
    const expanded = halosFor(frost, 7);
    expect(expanded.slice(0, frost.halos.length)).toEqual(frost.halos);
    expect(halosFor(frost, 6)).toEqual(expanded.slice(0, 6));
    expect(halosFor(frost, 3)).toEqual(frost.halos.slice(0, 3));
  });

  it("preserves a hidden slot's color when its halo is added back", () => {
    const override = { ...DEFAULT_HALO_OVERRIDE, enabled: true, colors: [null, "#ff00ff"] };
    expect(resolveTextureHalos(NO_TEXTURE, { ...override, count: 1 }).halos).toHaveLength(1);
    expect(resolveTextureHalos(NO_TEXTURE, { ...override, count: 2 }).halos[1].color).toContain(
      "#ff00ff",
    );
  });

  it("adds grain and a fallback material independently of halo activation", () => {
    const override = { ...DEFAULT_HALO_OVERRIDE, enabled: false, grainOpacity: 0.36 };
    const resolved = resolveTextureHalos(NO_TEXTURE, override);
    expect(resolved.halos).toEqual([]);
    expect(resolved.base).not.toBeNull();
    expect(resolved.veil).toBe(true);
    expect(resolved.grain).toEqual({ ...FROST_GRAIN, opacity: 0.36, blend: "screen" });
    expect(resolveTextureHalos(NO_TEXTURE, { ...override, grainOpacity: 0 })).toBe(NO_TEXTURE);
  });

  it("uses multiplied grain on a smooth light theme", () => {
    const resolved = resolveTextureHalos(
      NO_TEXTURE,
      { ...DEFAULT_HALO_OVERRIDE, grainOpacity: 0.19 },
      "light",
    );
    expect(resolved.grain?.blend).toBe("multiply");
    expect(resolved.grain?.opacity).toBe(0.19);
  });

  it("preserves an authored grain's material when only its strength is changed", () => {
    const texture = { ...NO_TEXTURE, grain: frost.grain };
    const override = { ...DEFAULT_HALO_OVERRIDE, grainOpacity: frost.grain?.opacity };
    expect(usesFallbackTexture(texture, override)).toBe(false);
    expect(resolveTextureHalos(texture, override)).toBe(texture);

    const stronger = resolveTextureHalos(texture, { ...override, grainOpacity: 0.7 });
    expect(stronger.base).toBeNull();
    expect(stronger.veil).toBe(false);
    expect(stronger.grain).toEqual({ ...frost.grain, opacity: 0.7 });
    expect(resolveTextureHalos(texture, { ...override, grainOpacity: 0 }).grain).toBeNull();
  });
});
