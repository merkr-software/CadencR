import type { GatePopoverSurface } from "@/stores/pending-gate-popover-store";

/** Marks a status icon that opens a quick reply, so a surface can be told from what renders. */
export const GATE_TRIGGER_ATTRIBUTES = {
  trigger: "data-gate-trigger",
  featureId: "data-gate-feature-id",
  surface: "data-gate-surface",
} as const;

/**
 * Whether `featureId`'s quick-reply icon is on screen in `surface`. A collapsed
 * sidebar stays mounted but inert: its rows don't count.
 */
function rendersOn(featureId: number, surface: GatePopoverSurface): boolean {
  if (typeof document === "undefined") return false;
  const icons = document.querySelectorAll(
    `[${GATE_TRIGGER_ATTRIBUTES.trigger}][${GATE_TRIGGER_ATTRIBUTES.featureId}="${featureId}"][${GATE_TRIGGER_ATTRIBUTES.surface}="${surface}"]`,
  );
  return Array.from(icons).some((icon) => icon.closest("[inert]") === null);
}

const SURFACES: readonly GatePopoverSurface[] = ["rail", "for-me", "tree", "working", "recent"];

/**
 * Where to open `featureId`'s quick reply: the first of `preferred` whose row
 * renders it (the surface the popover was on, then the one that owns it), else
 * any other surface rendering it, else the bottom sheet, which needs no row.
 */
export function resolveGateSurface(
  featureId: number,
  preferred: readonly (GatePopoverSurface | null | undefined)[],
): GatePopoverSurface {
  for (const surface of preferred) {
    if (surface && surface !== "sheet" && rendersOn(featureId, surface)) return surface;
  }
  return SURFACES.find((surface) => rendersOn(featureId, surface)) ?? "sheet";
}
