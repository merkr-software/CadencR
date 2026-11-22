/**
 * Presentation of catalog-declared modes (providers without a built-in mode
 * table). The host mode id supplies the icon, risk and default color.
 * A provider can declare a theme accent for the color.
 */
import {
  Bot,
  ClipboardList,
  FileEditIcon,
  Hammer,
  MessageCircleQuestion,
  ShieldOff,
  Sparkles,
} from "lucide-react";

import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import type { BuiltinPermissionMode } from "@/types/permission-mode";
import { MODE_ACCENTS } from "./provider-mode-accents";
import type { ProviderMode } from "./provider-modes";

type CatalogModeStyle = Pick<ProviderMode, "icon" | "risk" | "tone" | "chipClass">;

const CATALOG_MODE_STYLES: Record<BuiltinPermissionMode, CatalogModeStyle> = {
  default: {
    icon: Hammer,
    risk: "ask",
    ...MODE_ACCENTS.blue,
  },
  acceptEdits: {
    icon: FileEditIcon,
    risk: "edits",
    ...MODE_ACCENTS.violet,
  },
  plan: {
    icon: ClipboardList,
    risk: "read",
    ...MODE_ACCENTS.yellow,
  },
  ask: {
    icon: MessageCircleQuestion,
    risk: "read",
    ...MODE_ACCENTS.green,
  },
  auto: {
    icon: Sparkles,
    risk: "auto",
    tone: "var(--chip-fuchsia-fg)",
    chipClass:
      "bg-[var(--chip-fuchsia-bg)]/15 text-[var(--chip-fuchsia-fg)] hover:bg-[var(--chip-fuchsia-bg)]/25",
  },
  bypassPermissions: {
    icon: ShieldOff,
    risk: "bypass",
    tone: "var(--acc-red)",
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
  },
  dontAsk: {
    icon: ShieldOff,
    risk: "bypass",
    tone: "var(--acc-red)",
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
  },
};

/** Ids outside the host vocabulary make no claim about autonomy: the neutral level. */
export const UNKNOWN_MODE_STYLE: CatalogModeStyle = {
  icon: Bot,
  risk: "ask",
  tone: "var(--acc-cyan)",
  chipClass: "bg-[var(--acc-cyan)]/15 text-[var(--acc-cyan)] hover:bg-[var(--acc-cyan)]/25",
};

/**
 * A catalog mode as a chip/cycle entry. Never opt-in: the provider already
 * chose to declare it, so no host-side toggle gates it.
 */
export function catalogProviderMode(mode: RuntimeProviderModeOption): ProviderMode {
  const style =
    mode.id in CATALOG_MODE_STYLES
      ? CATALOG_MODE_STYLES[mode.id as BuiltinPermissionMode]
      : UNKNOWN_MODE_STYLE;
  return {
    ...style,
    ...(mode.accent && MODE_ACCENTS[mode.accent]),
    id: mode.id,
    label: mode.label,
    description: mode.description ?? mode.label,
  };
}
