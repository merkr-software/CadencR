/**
 * Per-theme tuning of a texture's halos, kept beside the theme rather than in it.
 *
 * A theme's halos are data (`chrome.texture.halos`), so retuning them needs no
 * new rendering path — only somewhere to put the user's choices and a transform
 * applied before `<AmbientBackground/>` paints. This module is both halves.
 *
 * Why an override and not an edit of the theme: the Frost pair are built-ins
 * with no file to write, a `managed:` theme is replaced on update, and a user
 * theme's `theme.json` is a file the user (or an agent) is editing in a project,
 * with live reload and a git diff on it. A slider writing there would fight all
 * three.
 *
 * So the override is a *transform*, not a copy of the halo array: rotation,
 * intensity, and a color per index. A theme that later moves its halos or
 * changes their size keeps the tuning valid, which a stored copy would not.
 */

import { z } from "zod";
import { parseJsonSetting, type ParsedJsonSetting } from "@/lib/json-setting";
import { clamp } from "@/lib/math";
import type { ThemeHalo, ThemeTexture } from "./chrome";
import type { ThemeId } from "./types";

/**
 * The bounds the theme validator enforces on a halo's center, in percent.
 * Mirror of `HALO_OFFSET` in `packages/plugin-core/src/theme/chrome/validation.rs`
 * — a rotation must not push a center outside what a theme file may declare.
 */
const HALO_OFFSET_MIN = -200;
const HALO_OFFSET_MAX = 200;

/** Rotation is a full turn either way; intensity is a multiplier on opacity. */
export const ROTATION_RANGE = { min: -180, max: 180, step: 5 } as const;
export const INTENSITY_RANGE = { min: 0, max: 2, step: 0.05 } as const;

/**
 * How the field moves.
 *
 * `still` holds the composition the theme authored. The other three are three
 * different answers to "make it move", and they cost very different things:
 * `orbit` and `glow` are pure CSS on layers that already exist, `lava` runs a
 * simulation (see `halo-lava.ts`) because blobs that slide around each other
 * cannot be expressed as a keyframe.
 */
export const HALO_MOTIONS = ["still", "orbit", "lava", "glow"] as const;
export type HaloMotion = (typeof HALO_MOTIONS)[number];

export const HALO_MOTION_LABELS: Record<HaloMotion, string> = {
  still: "Still",
  orbit: "Circular",
  lava: "Lava lamp",
  glow: "Glowing",
};

/**
 * Pace, `1`–`18`, read differently by each motion.
 *
 * One slider rather than three, because the three are the same question — how
 * fast — and a panel with a speed control that changes unit per mode is worse
 * than one that says what the unit is. The conversions live in
 * `orbitSeconds` / `glowSeconds` / `lavaSpeed` below, and the panel prints the
 * unit the current mode actually uses.
 */
export const SPEED_RANGE = { min: 1, max: 18, step: 1 } as const;
export const DEFAULT_HALO_SPEED = 4;

/**
 * What the user changed about one theme's halos.
 *
 * `colors` is index-aligned with the theme's own halo array and sparse: `null`
 * means "leave this halo the color the theme gave it". Storing `null` rather
 * than the theme's color is what keeps a color reset from pinning a value the
 * theme may later change.
 */
export interface HaloOverride {
  /** Degrees, clockwise, around the viewport center. Ignored unless `still`. */
  rotation: number;
  /** Multiplier on every halo's opacity. `1` is the theme's own strength. */
  intensity: number;
  colors: (string | null)[];
  /**
   * How the field moves. A fixed angle and a moving field answer the same
   * question, so `rotation` is ignored unless this is `still` — the panel greys
   * it out rather than letting two controls fight over one value.
   */
  motion: HaloMotion;
  /** Pace, `1`–`18`. See `SPEED_RANGE`. */
  speed: number;
}

/** Every theme's overrides, keyed by theme id (`frost-dark`, `user:mine`, …). */
export type HaloOverrideMap = Partial<Record<ThemeId, HaloOverride>>;

export const DEFAULT_HALO_OVERRIDE: HaloOverride = {
  rotation: 0,
  intensity: 1,
  colors: [],
  motion: "still",
  speed: DEFAULT_HALO_SPEED,
};

/**
 * One entry, narrowed from whatever the settings row held.
 *
 * Every field falls back on its own, so a hand-edited entry that gets one key
 * wrong costs that field and not the theme's whole tuning.
 */
const haloOverrideSchema = z.object({
  rotation: z.number().catch(DEFAULT_HALO_OVERRIDE.rotation),
  intensity: z.number().catch(DEFAULT_HALO_OVERRIDE.intensity),
  // Per slot, not per array: one bad entry costs that halo its color, not the
  // whole palette.
  colors: z.array(z.string().nullable().catch(null)).catch([]),
  motion: z.enum(HALO_MOTIONS).catch(DEFAULT_HALO_OVERRIDE.motion),
  speed: z.number().catch(DEFAULT_HALO_OVERRIDE.speed),
});

const haloOverrideMapSchema = z.record(z.string(), haloOverrideSchema);

/** Pull the parsed entry into the ranges the panel can produce. */
function normalize(parsed: z.infer<typeof haloOverrideSchema>): HaloOverride {
  return {
    rotation: clamp(parsed.rotation, ROTATION_RANGE.min, ROTATION_RANGE.max),
    intensity: clamp(parsed.intensity, INTENSITY_RANGE.min, INTENSITY_RANGE.max),
    colors: parsed.colors.map((color) => (color === "" ? null : color)),
    motion: parsed.motion,
    speed: clamp(parsed.speed, SPEED_RANGE.min, SPEED_RANGE.max),
  };
}

/**
 * The whole setting, from the raw string the settings table holds.
 *
 * A malformed value reads as "nothing tuned" and reports why, rather than
 * throwing: the panel is decoration, and a corrupt row must not take the app
 * down. The caller decides whether to say so.
 */
export function parseHaloOverrides(
  raw: string | null | undefined,
): ParsedJsonSetting<HaloOverrideMap> {
  const parsed = parseJsonSetting(raw, haloOverrideMapSchema, "an object keyed by theme id");
  if (parsed.value === null) return parsed;
  const map: HaloOverrideMap = {};
  for (const [themeId, entry] of Object.entries(parsed.value)) {
    map[themeId as ThemeId] = normalize(entry);
  }
  return { value: map, error: null };
}

/** Whether an override asks for anything at all. */
export function isDefaultOverride(override: HaloOverride): boolean {
  return (
    override.rotation === DEFAULT_HALO_OVERRIDE.rotation &&
    override.intensity === DEFAULT_HALO_OVERRIDE.intensity &&
    override.motion === DEFAULT_HALO_OVERRIDE.motion &&
    override.speed === DEFAULT_HALO_OVERRIDE.speed &&
    override.colors.every((color) => color === null)
  );
}

/**
 * The alpha a CSS color string carries, `0..1`.
 *
 * Needed because a theme's halo colors are routinely translucent — Catppuccin
 * Frost's are `#cba6f7b8`, 73% — and swapping in an opaque palette swatch would
 * otherwise raise the halo's strength by a third. Only the alpha is read, never
 * the color: re-emitting the picked color at the theme's alpha is `color-mix`'s
 * job, and that needs no parsing of the picked value.
 *
 * Covers the syntaxes the theme validator accepts. Anything unrecognized reads
 * as opaque, which is the safe direction: the halo keeps the strength the user
 * picked rather than silently fading.
 */
export function colorAlpha(color: string): number {
  const value = color.trim().toLowerCase();
  if (value === "transparent") return 0;

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 4) return hexAlpha(hex[3] + hex[3]);
    if (hex.length === 8) return hexAlpha(hex.slice(6, 8));
    return 1;
  }

  const open = value.indexOf("(");
  if (open === -1 || !value.endsWith(")")) return 1;
  const body = value.slice(open + 1, -1);

  // Modern syntax puts alpha after a slash: `oklch(0.6 0.12 230 / 0.55)`.
  const slash = body.lastIndexOf("/");
  if (slash !== -1) return parseAlphaComponent(body.slice(slash + 1));

  // Legacy `rgba()` / `hsla()` carry it as a fourth comma-separated argument.
  const parts = body.split(",");
  if (parts.length === 4) return parseAlphaComponent(parts[3]);

  return 1;
}

/** A two-digit hex pair as an alpha. `#gggg` is not a color, so it reads opaque. */
function hexAlpha(pair: string): number {
  const parsed = Number.parseInt(pair, 16);
  return Number.isFinite(parsed) ? parsed / 255 : 1;
}

function parseAlphaComponent(raw: string): number {
  const value = raw.trim();
  const parsed = value.endsWith("%")
    ? Number.parseFloat(value.slice(0, -1)) / 100
    : Number.parseFloat(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : 1;
}

/**
 * `color` at `alpha`, without parsing `color`.
 *
 * `color-mix` against `transparent` is the one CSS expression that applies an
 * alpha to an arbitrary color value, which is what lets the palette offer plain
 * theme tokens (`oklch(…)`, `#rrggbb`) against a halo that was authored
 * translucent.
 */
function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  return `color-mix(in srgb, ${color} ${(alpha * 100).toFixed(2)}%, transparent)`;
}

/**
 * The picked color, at the strength the theme authored.
 *
 * A picked color that is itself translucent is honoured as-is: the user asked
 * for that alpha, and compounding it with the theme's would be a surprise.
 */
function applyColor(original: string, picked: string): string {
  if (colorAlpha(picked) < 1) return picked;
  return withAlpha(picked, colorAlpha(original));
}

/**
 * Rotate a halo's center around the viewport center.
 *
 * `x` and `y` are percentages of *different* axes, so this is not a true
 * rotation on a non-square window — it shears. On a field of 60–70vw circles
 * blurred by 80px the shear is invisible, and the alternative (converting
 * through the live aspect ratio) would make the composition depend on window
 * size, which is exactly what percentage centers exist to avoid.
 *
 * Written to `left`/`top`, never to `transform`: that belongs to the drift
 * animation, and the two would fight.
 */
function rotateHalo(halo: ThemeHalo, degrees: number): ThemeHalo {
  if (degrees === 0) return halo;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = halo.x - 50;
  const dy = halo.y - 50;
  return {
    ...halo,
    x: clamp(50 + dx * cos - dy * sin, HALO_OFFSET_MIN, HALO_OFFSET_MAX),
    y: clamp(50 + dx * sin + dy * cos, HALO_OFFSET_MIN, HALO_OFFSET_MAX),
  };
}

/**
 * One halo with the override applied, or the halo itself when the override
 * leaves it alone — which is the common case for a theme the user only made
 * move.
 */
export function resolveHalo(halo: ThemeHalo, override: HaloOverride, index: number): ThemeHalo {
  // A moving field has no fixed angle: the motion is the angle, so the static
  // one is dropped rather than added to it.
  const degrees = override.motion === "still" ? override.rotation : 0;
  const picked = override.colors[index] ?? null;
  if (degrees === 0 && picked === null && override.intensity === 1) return halo;

  const rotated = rotateHalo(halo, degrees);
  return {
    ...rotated,
    color: picked === null ? rotated.color : applyColor(rotated.color, picked),
    opacity: clamp(rotated.opacity * override.intensity, 0, 1),
  };
}

/**
 * How long one full turn takes, in seconds — or `null` when the field is not
 * orbiting.
 *
 * The panel edits a pace because that is what a person drags; CSS needs a
 * duration. Converting in one place keeps the two from drifting apart.
 */
export function orbitSeconds(override: HaloOverride): number | null {
  if (override.motion !== "orbit") return null;
  return 360 / override.speed;
}

/**
 * How long one breath of the glow takes, in seconds — or `null` when the field
 * is not glowing.
 *
 * Capped at 3s: the pace range reaches 18, and `40 / 18` would pulse twice a
 * second, which reads as a flicker rather than a glow.
 */
export function glowSeconds(override: HaloOverride): number | null {
  if (override.motion !== "glow") return null;
  return Math.max(3, 40 / override.speed);
}

/**
 * How fast the lava blobs travel, in `vw` per second — or `null` when the field
 * is not a lava lamp.
 *
 * `vw` rather than px so the motion is the same on any window: the simulation
 * multiplies by the live viewport width. The `0.35` is what makes the pace
 * range land on a lava lamp rather than a screensaver — at the default `4` a
 * blob crosses the play area in about half a minute.
 */
export function lavaSpeed(override: HaloOverride): number | null {
  if (override.motion !== "lava") return null;
  return override.speed * 0.35;
}

/**
 * The texture as it should paint, or the texture itself when nothing changed.
 *
 * Returning the same object is what keeps `<AmbientBackground/>`'s memo intact:
 * a fresh texture on every render would re-render every halo layer on every
 * settings change that passes through — including a speed or motion change,
 * which cannot alter a single halo.
 */
export function resolveTextureHalos(texture: ThemeTexture, override: HaloOverride): ThemeTexture {
  if (texture.halos.length === 0) return texture;
  const halos = texture.halos.map((halo, index) => resolveHalo(halo, override, index));
  if (halos.every((halo, index) => halo === texture.halos[index])) return texture;
  return { ...texture, halos };
}

/** The override for one theme, or the default when it has none. */
export function overrideFor(map: HaloOverrideMap, themeId: ThemeId): HaloOverride {
  return map[themeId] ?? DEFAULT_HALO_OVERRIDE;
}

/**
 * The map with one theme's override replaced, or removed when it is back to the
 * default — so a theme the user reset leaves nothing behind in the setting.
 */
export function withOverride(
  map: HaloOverrideMap,
  themeId: ThemeId,
  override: HaloOverride,
): HaloOverrideMap {
  if (isDefaultOverride(override)) {
    if (!(themeId in map)) return map;
    const next = { ...map };
    delete next[themeId];
    return next;
  }
  return { ...map, [themeId]: override };
}
