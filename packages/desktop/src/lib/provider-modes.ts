/**
 * Per-provider permission-mode catalog. Single source of truth for what
 * appears in the prompt-bar mode chip & the Shift+Tab cycle.
 *
 * Mirrors the backend `provider_supports_mode` matrix
 * (packages/service/src/domain/ws_session/handler/mod.rs).
 */
import {
  ClipboardList,
  Bot,
  FileEditIcon,
  Hammer,
  ShieldOff,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { PROVIDER_IDS, type ProviderId } from "./providers";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import type { PermissionMode } from "@/types/permission-mode";

export interface ProviderMode {
  /** Wire value sent to the backend. */
  id: PermissionMode;
  /** Chip label. */
  label: string;
  icon: LucideIcon;
  /**
   * Tailwind classes for the chip in its selected state. Hover variant
   * included; matches the existing chip pattern in MetaBar.
   */
  chipClass: string;
  /** Tooltip + a11y description. */
  description: string;
  /**
   * Hidden from the cycle by default; only appears when the matching
   * provider-level toggle is enabled (Claude Code's "Allow BypassPermissions",
   * Codex's "Allow Full Access").
   */
  optIn?: boolean;
}

// Chips route through theme tokens (defined per theme in index.css) so
// contrast holds in both Dracula and Aurora. We use `--chip-*` for chip
// identities that fall outside the canonical Dracula palette (violet,
// fuchsia, blue) and `--acc-*` for the ones that already match (green,
// yellow, red, pink, cyan).

const CLAUDE_CODE_MODES: ProviderMode[] = [
  {
    id: "acceptEdits",
    label: "Auto-Accept Edits",
    icon: FileEditIcon,
    chipClass:
      "bg-[var(--chip-violet-bg)]/15 text-[var(--chip-violet-fg)] hover:bg-[var(--chip-violet-bg)]/25",
    description: "Auto-approve file edits in the working directory.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    chipClass: "bg-[var(--acc-green)]/15 text-[var(--acc-green)] hover:bg-[var(--acc-green)]/25",
    description: "Research and propose changes without editing source.",
  },
  {
    id: "auto",
    label: "Auto",
    icon: Sparkles,
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
    description:
      "Classifier-backed: safe actions auto-run, risky ones blocked. Requires Sonnet 4.6 / Opus 4.6+.",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    icon: ShieldOff,
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
    description: "DANGEROUS: skip every safety check. Only use in isolated containers / VMs.",
    optIn: true,
  },
];

const OPENCODE_MODES: ProviderMode[] = [
  {
    id: "acceptEdits",
    label: "Build",
    icon: Hammer,
    chipClass:
      "bg-[var(--chip-fuchsia-bg)]/15 text-[var(--chip-fuchsia-fg)] hover:bg-[var(--chip-fuchsia-bg)]/25",
    description: "Default OpenCode agent with all tools enabled.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
    description: "Restricted OpenCode agent for analysis without changes.",
  },
];

const CODEX_MODES: ProviderMode[] = [
  {
    id: "default",
    label: "Default",
    icon: Zap,
    chipClass:
      "bg-[var(--chip-blue-bg)]/15 text-[var(--chip-blue-fg)] hover:bg-[var(--chip-blue-bg)]/25",
    description: "Workspace-write sandbox with on-request approvals.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    chipClass:
      "bg-[var(--chip-fuchsia-bg)]/15 text-[var(--chip-fuchsia-fg)] hover:bg-[var(--chip-fuchsia-bg)]/25",
    description: "Plan first; sandbox/approvals match Default.",
  },
  {
    id: "bypassPermissions",
    label: "Full Access",
    icon: ShieldOff,
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
    description: "DANGEROUS: full filesystem and network access, no approvals.",
    optIn: true,
  },
];

export const PROVIDER_MODES: Record<ProviderId, ProviderMode[]> = {
  [PROVIDER_IDS.CLAUDE_CODE]: CLAUDE_CODE_MODES,
  [PROVIDER_IDS.OPENCODE]: OPENCODE_MODES,
  [PROVIDER_IDS.CODEX_CLI]: CODEX_MODES,
};

/**
 * Look up the catalog for a provider. Returns `[]` when the id is unknown so
 * the chip hides via the standard < 2 visible-modes gate in MetaBar — better
 * than masquerading as a Claude session with Claude colors and labels.
 */
export function getProviderModes(
  providerId?: string | null,
  catalogModes: readonly RuntimeProviderModeOption[] = [],
): ProviderMode[] {
  if (providerId && providerId in PROVIDER_MODES) {
    const modes = PROVIDER_MODES[providerId as ProviderId];
    if (providerId !== PROVIDER_IDS.OPENCODE || catalogModes.length === 0) return modes;
    return [...modes, ...catalogModes.map(opencodeCatalogMode)];
  }
  return [];
}

function opencodeCatalogMode(mode: RuntimeProviderModeOption): ProviderMode {
  return {
    id: mode.id,
    label: mode.label,
    icon: Bot,
    chipClass: "bg-[var(--acc-cyan)]/15 text-[var(--acc-cyan)] hover:bg-[var(--acc-cyan)]/25",
    description: mode.description ?? `Use the OpenCode ${mode.label} agent.`,
  };
}

/**
 * Filter the provider's catalog down to the modes the user is allowed to
 * cycle through right now. Opt-in modes are gated by the matching
 * provider-level setting (Claude bypass, Codex full-access).
 */
export function getVisibleModes(
  providerId: string | null | undefined,
  enabledOptInIds: PermissionMode[] = [],
  catalogModes: readonly RuntimeProviderModeOption[] = [],
): ProviderMode[] {
  return getProviderModes(providerId, catalogModes).filter(
    (mode) => !mode.optIn || enabledOptInIds.includes(mode.id),
  );
}

/**
 * Resolve the mode definition for a given (provider, mode-id) pair. Returns
 * `null` when the catalog has no match — caller is expected to fall back to
 * the provider's primary mode rather than render an empty chip.
 */
export function findProviderMode(
  providerId: string | null | undefined,
  modeId: PermissionMode,
  catalogModes: readonly RuntimeProviderModeOption[] = [],
): ProviderMode | null {
  return getProviderModes(providerId, catalogModes).find((m) => m.id === modeId) ?? null;
}

/**
 * The "primary edit" mode for a provider — used as the default at session
 * start and on provider switch.
 *
 * The post-plan-approval target is intentionally backend-owned: the
 * bridge resolves it from the live model catalog (Claude's classifier-
 * backed `auto` only when the model supports it) and broadcasts the
 * outcome via `mode.changed`. Don't add an FE preview helper unless
 * something actually consumes it — drift between FE guess and BE truth
 * is exactly the bug class this code path is trying to eliminate.
 */
export function defaultEditModeFor(providerId: string | null | undefined): PermissionMode {
  return getProviderModes(providerId)[0]?.id ?? "acceptEdits";
}

/**
 * Compute the next mode in the Shift+Tab cycle. Wraps around the end of the
 * filtered list. Falls back to the current mode when the list has < 2 items.
 */
export function nextProviderMode(
  providerId: string | null | undefined,
  current: PermissionMode,
  enabledOptInIds: PermissionMode[] = [],
  catalogModes: readonly RuntimeProviderModeOption[] = [],
): PermissionMode {
  const visible = getVisibleModes(providerId, enabledOptInIds, catalogModes);
  if (visible.length < 2) return current;
  const idx = visible.findIndex((m) => m.id === current);
  if (idx === -1) return visible[0].id;
  return visible[(idx + 1) % visible.length].id;
}
