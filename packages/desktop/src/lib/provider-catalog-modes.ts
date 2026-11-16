/**
 * Presentation of catalog-declared modes (providers without a built-in mode
 * table). A provider declares only the host mode id, label and description;
 * icon, risk and color derive from the host mode id alone, so two providers
 * offering "plan" look the same and no provider id is consulted.
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
import type { ProviderMode } from "./provider-modes";

type CatalogModeStyle = Pick<ProviderMode, "icon" | "risk" | "tone" | "chipClass">;

const CATALOG_MODE_STYLES: Record<BuiltinPermissionMode, CatalogModeStyle> = {
  default: {
    icon: Hammer,
    risk: "ask",
    tone: "var(--chip-blue-fg)",
    chipClass:
      "bg-[var(--chip-blue-bg)]/15 text-[var(--chip-blue-fg)] hover:bg-[var(--chip-blue-bg)]/25",
  },
  acceptEdits: {
    icon: FileEditIcon,
    risk: "edits",
    tone: "var(--chip-violet-fg)",
    chipClass:
      "bg-[var(--chip-violet-bg)]/15 text-[var(--chip-violet-fg)] hover:bg-[var(--chip-violet-bg)]/25",
  },
  plan: {
    icon: ClipboardList,
    risk: "read",
    tone: "var(--acc-yellow)",
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
  },
  ask: {
    icon: MessageCircleQuestion,
    risk: "read",
    tone: "var(--acc-green)",
    chipClass: "bg-[var(--acc-green)]/15 text-[var(--acc-green)] hover:bg-[var(--acc-green)]/25",
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
    id: mode.id,
    label: mode.label,
    description: mode.description ?? mode.label,
  };
}
