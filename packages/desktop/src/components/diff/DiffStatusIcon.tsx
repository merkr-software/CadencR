import { type ReactElement } from "react";
import { SVGSpriteSheet, getIconForType } from "@pierre/diffs";
import { type FileDiffSection } from "@/lib/parse-unified-diff";
import type { ThemeAppearance } from "@/lib/themes";

/**
 * Git change kind for a file, mapped 1:1 onto Pierre's file-header change
 * types so the collapsed header icon matches the one Pierre draws in the
 * expanded header.
 */
export type DiffChangeType = "new" | "deleted" | "change" | "renamed";

/** Derive the change kind from a parsed diff section's old/new file names. */
export function deriveChangeType(section: FileDiffSection): DiffChangeType {
  if (section.oldFileName === "/dev/null") return "new";
  if (section.newFileName === "/dev/null") return "deleted";
  if (section.oldFileName !== section.newFileName) return "renamed";
  return "change";
}

// Pierre colors its header change icon from --diffs-*-base, which default to
// these values (see @pierre/diffs `style.js`). The collapsed header is a cheap
// non-Pierre row that lives in the light DOM, so we reproduce the same colors
// here to stay visually identical. Renames reuse the "modified" hue, exactly
// like Pierre does.
const CHANGE_COLOR: Record<DiffChangeType, { light: string; dark: string }> = {
  new: { light: "#0dbe4e", dark: "#5ecc71" },
  deleted: { light: "#ff2e3f", dark: "#ff6762" },
  change: { light: "#009fff", dark: "#69b1ff" },
  renamed: { light: "#009fff", dark: "#69b1ff" },
};

function appearanceKey(appearance: ThemeAppearance): "light" | "dark" {
  return appearance === "dark" ? "dark" : "light";
}

/**
 * Pierre's exact `+A` / `-D` count colors for the active appearance, so the
 * file header's numstat matches the additions/deletions Pierre paints in the
 * diff body (it derives both from --diffs-addition-base / --diffs-deletion-base,
 * which cadencr leaves at these defaults).
 */
export function pierreDiffCountColors(appearance: ThemeAppearance): { add: string; del: string } {
  const key = appearanceKey(appearance);
  return { add: CHANGE_COLOR.new[key], del: CHANGE_COLOR.deleted[key] };
}

const PIERRE_ICON_TYPE: Record<DiffChangeType, Parameters<typeof getIconForType>[0]> = {
  new: "new",
  deleted: "deleted",
  change: "change",
  renamed: "rename-changed",
};

const SPRITE_HOST_ID = "cadencr-diff-icon-sprite";
let spriteInjected = false;

/**
 * Inject Pierre's SVG symbol sprite into the light DOM once so the `<use>`
 * reference below resolves. Pierre injects the same sprite inside each diff's
 * shadow root, but the collapsed header lives in the light DOM and can't reach
 * those. Kept synchronous (not in an effect) so the glyph never paints empty;
 * the module-level flag makes repeat calls in the render path a no-op.
 */
function ensureSpriteInjected(): void {
  if (spriteInjected || typeof document === "undefined") return;
  spriteInjected = true;
  if (document.getElementById(SPRITE_HOST_ID)) return;
  const host = document.createElement("div");
  host.id = SPRITE_HOST_ID;
  host.style.display = "none";
  host.setAttribute("aria-hidden", "true");
  host.innerHTML = SVGSpriteSheet;
  document.body.appendChild(host);
}

/** Pierre's file-status glyph (add/delete/modify/rename), colored to match. */
export function DiffStatusIcon({
  type,
  appearance,
}: {
  type: DiffChangeType;
  appearance: ThemeAppearance;
}): ReactElement {
  ensureSpriteInjected();
  const symbol = getIconForType(PIERRE_ICON_TYPE[type]);
  const color = CHANGE_COLOR[type][appearanceKey(appearance)];
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0"
      style={{ fill: color }}
    >
      <use href={`#${symbol}`} />
    </svg>
  );
}
