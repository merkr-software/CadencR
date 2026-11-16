import { ClipboardList, Shield, ShieldCheck, ShieldOff, type LucideIcon } from "lucide-react";
import { PROVIDER_IDS } from "@/lib/providers";
import { findProviderMode, type ProviderMode } from "@/lib/provider-modes";
import type { PermissionMode } from "@/types/permission-mode";
import type { AccessMode } from "@/types/access-mode";

export interface DisplayModeDefinition {
  label: string;
  description: string;
  ariaLabel: string;
  chipClass: string;
  icon: LucideIcon;
}

export function getDisplayMode(
  activeMode: ProviderMode | null,
  providerId: string | undefined,
  permissionMode: PermissionMode | undefined,
): DisplayModeDefinition | null {
  if (!activeMode) return null;
  if (providerId !== PROVIDER_IDS.CODEX_CLI) return providerDisplayMode(activeMode);
  return codexPlanDisplayMode(activeMode, permissionMode);
}

function providerDisplayMode(activeMode: ProviderMode): DisplayModeDefinition {
  return {
    label: activeMode.label,
    description: activeMode.description,
    ariaLabel: `Permission mode: ${activeMode.label}. ${activeMode.description}`,
    chipClass: activeMode.chipClass,
    icon: activeMode.icon,
  };
}

function codexPlanDisplayMode(
  fallbackMode: ProviderMode,
  permissionMode: PermissionMode | undefined,
): DisplayModeDefinition {
  const planMode = findProviderMode(PROVIDER_IDS.CODEX_CLI, "plan") ?? fallbackMode;
  const isPlan = permissionMode === "plan";
  const description = isPlan
    ? planMode.description
    : // The chip's title appends the live cycle shortcut, so no key is named here.
      "Default Codex collaboration mode. Click to enable Plan.";
  return {
    label: isPlan ? "Plan" : "Default",
    description,
    ariaLabel: `Permission mode: ${isPlan ? "Plan" : "Default"}. ${description}`,
    chipClass: isPlan ? planMode.chipClass : "bg-muted/40 text-muted-foreground hover:bg-muted/60",
    icon: ClipboardList,
  };
}

export interface AccessModeDefinition {
  id: AccessMode;
  label: string;
  description: string;
  longDescription: string;
  chipClass: string;
  textClass: string;
  icon: LucideIcon;
}

// Access modes are a sandbox axis, so they share the shield family — and never
// reuse a mode or Fast icon: the composer shows them side by side.
export const ACCESS_MODE_DEFINITIONS: AccessModeDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Workspace-write sandbox with user-reviewed approvals.",
    longDescription:
      "Runs in the workspace-write sandbox. Codex asks you to review command, network, or file access when approval is needed.",
    chipClass:
      "bg-[var(--chip-blue-bg)]/15 text-[var(--chip-blue-fg)] hover:bg-[var(--chip-blue-bg)]/25",
    textClass: "text-[var(--chip-blue-fg)]",
    icon: Shield,
  },
  {
    id: "fullAccess",
    label: "Full Access",
    description: "DANGEROUS: full filesystem and network access, no approvals.",
    longDescription:
      "Disables sandboxing and approval prompts. Codex can run commands and access files/network without asking first.",
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
    textClass: "text-[var(--acc-red)]",
    icon: ShieldOff,
  },
  {
    id: "autoReview",
    label: "Auto Review",
    description: "Workspace-write sandbox with Codex auto-reviewing approval requests.",
    longDescription:
      "Keeps the workspace-write sandbox, but lets Codex automatically review approval requests instead of routing each one to you.",
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
    textClass: "text-[var(--acc-yellow)]",
    icon: ShieldCheck,
  },
];

export function getAccessModeDefinition(mode: AccessMode | undefined): AccessModeDefinition | null {
  if (!mode) return null;
  return (
    ACCESS_MODE_DEFINITIONS.find((candidate) => candidate.id === mode) ?? ACCESS_MODE_DEFINITIONS[0]
  );
}
