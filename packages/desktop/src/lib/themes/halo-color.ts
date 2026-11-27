import { clamp } from "@/lib/math";

/** The alpha a CSS color carries; unrecognized expressions remain opaque. */
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
  const slash = body.lastIndexOf("/");
  if (slash !== -1) return parseAlphaComponent(body.slice(slash + 1));
  const parts = body.split(",");
  if (parts.length === 4) return parseAlphaComponent(parts[3]);
  return 1;
}

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
 * Keep authored alpha when selecting an opaque palette swatch. A color picked
 * with its own alpha is honored directly, without compounding transparency.
 */
export function applyHaloColor(original: string, picked: string): string {
  if (colorAlpha(picked) < 1) return picked;
  const alpha = colorAlpha(original);
  return alpha >= 1
    ? picked
    : `color-mix(in srgb, ${picked} ${(alpha * 100).toFixed(2)}%, transparent)`;
}
