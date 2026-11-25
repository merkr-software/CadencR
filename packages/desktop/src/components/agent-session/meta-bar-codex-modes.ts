import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { ClipboardList, Shield, ShieldCheck, ShieldOff, type LucideIcon } from "lucide-react";
import { MODE_ACCENTS } from "@/lib/provider-mode-accents";
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
  t: UiTranslator = translateUi,
): DisplayModeDefinition | null {
  if (!activeMode) return null;
  if (providerId !== PROVIDER_IDS.CODEX_CLI) return providerDisplayMode(activeMode, t);
  return codexPlanDisplayMode(activeMode, permissionMode, t);
}

function providerDisplayMode(activeMode: ProviderMode, t: UiTranslator): DisplayModeDefinition {
  return {
    label: activeMode.label,
    description: activeMode.description,
    ariaLabel: t(
      "conversation.stream.metaBar.permissionMode",
      "Permission mode: {{mode}}. {{description}}",
      { mode: activeMode.label, description: activeMode.description },
    ),
    chipClass: activeMode.chipClass,
    icon: activeMode.icon,
  };
}

function codexPlanDisplayMode(
  fallbackMode: ProviderMode,
  permissionMode: PermissionMode | undefined,
  t: UiTranslator,
): DisplayModeDefinition {
  const planMode = findProviderMode(PROVIDER_IDS.CODEX_CLI, "plan") ?? fallbackMode;
  const isPlan = permissionMode === "plan";
  const description = isPlan
    ? planMode.description
    : // The chip's title appends the live cycle shortcut, so no key is named here.
      t(
        "conversation.stream.metaBar.codexDefaultMode",
        "Default Codex collaboration mode. Click to enable Plan.",
      );
  const label = isPlan
    ? t("conversation.stream.metaBar.plan", "Plan")
    : t("conversation.stream.metaBar.defaultMode", "Default");
  return {
    label,
    description,
    ariaLabel: t(
      "conversation.stream.metaBar.permissionMode",
      "Permission mode: {{mode}}. {{description}}",
      { mode: label, description },
    ),
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
    get label() {
      return translateUi("conversation.stream.accessMode.default.label", "Default");
    },
    get description() {
      return translateUi(
        "conversation.stream.accessMode.default.description",
        "Workspace-write sandbox with user-reviewed approvals.",
      );
    },
    get longDescription() {
      return translateUi(
        "conversation.stream.accessMode.default.longDescription",
        "Runs in the workspace-write sandbox. Codex asks you to review command, network, or file access when approval is needed.",
      );
    },
    chipClass: MODE_ACCENTS.blue.chipClass,
    textClass: "text-[var(--chip-blue-fg)]",
    icon: Shield,
  },
  {
    id: "fullAccess",
    get label() {
      return translateUi("conversation.stream.accessMode.fullAccess.label", "Full Access");
    },
    get description() {
      return translateUi(
        "conversation.stream.accessMode.fullAccess.description",
        "DANGEROUS: full filesystem and network access, no approvals.",
      );
    },
    get longDescription() {
      return translateUi(
        "conversation.stream.accessMode.fullAccess.longDescription",
        "Disables sandboxing and approval prompts. Codex can run commands and access files/network without asking first.",
      );
    },
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
    textClass: "text-[var(--acc-red)]",
    icon: ShieldOff,
  },
  {
    id: "autoReview",
    get label() {
      return translateUi("conversation.stream.accessMode.autoReview.label", "Auto Review");
    },
    get description() {
      return translateUi(
        "conversation.stream.accessMode.autoReview.description",
        "Workspace-write sandbox with Codex auto-reviewing approval requests.",
      );
    },
    get longDescription() {
      return translateUi(
        "conversation.stream.accessMode.autoReview.longDescription",
        "Keeps the workspace-write sandbox, but lets Codex automatically review approval requests instead of routing each one to you.",
      );
    },
    chipClass: MODE_ACCENTS.yellow.chipClass,
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
