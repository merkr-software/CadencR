/**
 * Per-provider permission-mode catalog. Single source of truth for what
 * appears in the prompt-bar mode chip & the Shift+Tab cycle.
 *
 * Built-ins keep their hand-styled tables (mirroring the backend
 * `provider_supports_mode` matrix); every other provider gets its modes from
 * the runtime catalog, styled by the host mode id alone.
 */
import {
  ClipboardList,
  FileEditIcon,
  Hammer,
  ShieldOff,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { PROVIDER_IDS, type ProviderId } from "./providers";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import { catalogProviderMode, UNKNOWN_MODE_STYLE } from "./provider-catalog-modes";
import { getCatalogProviderMetadata } from "./provider-catalog-registry";
import { OPENCODE_AGENT_MODE_PREFIX, type PermissionMode } from "@/types/permission-mode";

/**
 * Provider-neutral autonomy level of a mode — what the agent may do without
 * asking. Drives the mode control's gloss (DESIGN.md › Mode risk scale); the
 * color stays the provider's own (`tone`).
 */
export type ModeRisk = "read" | "ask" | "edits" | "auto" | "bypass";

/** Short, provider-neutral gloss shown under the mode label. */
export const MODE_RISK_LABEL: Record<ModeRisk, string> = {
  read: "Read-only",
  ask: "Asks before acting",
  edits: "Edits without asking",
  auto: "Acts on its own",
  bypass: "No guardrails",
};

export interface ProviderMode {
  /** Wire value sent to the backend. */
  id: PermissionMode;
  risk: ModeRisk;
  /** Chip label. */
  label: string;
  icon: LucideIcon;
  /**
   * The mode's color — the one the provider's own UI uses, so a user moving
   * between the CLI and Cadencr recognizes the mode at a glance.
   */
  tone: string;
  /**
   * Tailwind classes for the tinted chip in its selected state (hover
   * included). Same hue as `tone`.
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

// Mode colors route through theme tokens (defined per theme in index.css) so
// contrast holds in every theme. `--chip-*` covers identities outside the
// canonical Dracula palette (violet, fuchsia, blue), `--acc-*` the ones that
// already match (green, yellow, red, cyan).

const CLAUDE_CODE_MODES: ProviderMode[] = [
  {
    id: "auto",
    label: "Auto",
    icon: Sparkles,
    risk: "auto",
    tone: "var(--acc-yellow)",
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
    description:
      "Classifier-backed: safe actions auto-run, risky ones blocked. Requires Sonnet 4.6 / Opus 4.6+.",
  },
  {
    id: "acceptEdits",
    label: "Auto-Accept Edits",
    icon: FileEditIcon,
    risk: "edits",
    tone: "var(--chip-violet-fg)",
    chipClass:
      "bg-[var(--chip-violet-bg)]/15 text-[var(--chip-violet-fg)] hover:bg-[var(--chip-violet-bg)]/25",
    description: "Auto-approve file edits in the working directory.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    risk: "read",
    tone: "var(--acc-green)",
    chipClass: "bg-[var(--acc-green)]/15 text-[var(--acc-green)] hover:bg-[var(--acc-green)]/25",
    description: "Research and propose changes without editing source.",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    icon: ShieldOff,
    risk: "bypass",
    tone: "var(--acc-red)",
    chipClass: "bg-[var(--acc-red)]/15 text-[var(--acc-red)] hover:bg-[var(--acc-red)]/25",
    description: "Dangerous: skip Claude Code permission prompts and checks.",
    optIn: true,
  },
];

const OPENCODE_MODES: ProviderMode[] = [
  {
    id: "acceptEdits",
    label: "Build",
    icon: Hammer,
    risk: "edits",
    tone: "var(--chip-fuchsia-fg)",
    chipClass:
      "bg-[var(--chip-fuchsia-bg)]/15 text-[var(--chip-fuchsia-fg)] hover:bg-[var(--chip-fuchsia-bg)]/25",
    description: "Default OpenCode agent with all tools enabled.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    risk: "read",
    tone: "var(--acc-yellow)",
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
    description: "Restricted OpenCode agent for analysis without changes.",
  },
];

const CODEX_MODES: ProviderMode[] = [
  {
    id: "default",
    label: "Default",
    icon: Hammer,
    risk: "ask",
    // Grey in the composer: on Codex only Plan is a "mode". The compact chip
    // (other surfaces) keeps its historical blue.
    tone: "var(--muted-foreground)",
    chipClass:
      "bg-[var(--chip-blue-bg)]/15 text-[var(--chip-blue-fg)] hover:bg-[var(--chip-blue-bg)]/25",
    description: "Workspace-write sandbox with on-request approvals.",
  },
  {
    id: "plan",
    label: "Plan",
    icon: ClipboardList,
    risk: "read",
    tone: "var(--chip-fuchsia-fg)",
    chipClass:
      "bg-[var(--chip-fuchsia-bg)]/15 text-[var(--chip-fuchsia-fg)] hover:bg-[var(--chip-fuchsia-bg)]/25",
    description: "Plan first; sandbox/approvals match Default.",
  },
];

export const PROVIDER_MODES: Record<ProviderId, ProviderMode[]> = {
  [PROVIDER_IDS.CLAUDE_CODE]: CLAUDE_CODE_MODES,
  [PROVIDER_IDS.OPENCODE]: OPENCODE_MODES,
  [PROVIDER_IDS.CODEX_CLI]: CODEX_MODES,
};

/**
 * Look up the catalog for a provider. Built-ins use their own table (OpenCode
 * appends its project agents from `catalogModes`). Any other provider uses the
 * catalog modes it declared — `catalogModes` when the caller holds the catalog,
 * else the last published catalog. Returns `[]` when nothing is known so the
 * chip hides via the standard < 2 visible-modes gate in MetaBar.
 */
export function getProviderModes(
  providerId?: string | null,
  catalogModes?: readonly RuntimeProviderModeOption[],
): ProviderMode[] {
  if (!providerId) return [];
  if (providerId in PROVIDER_MODES) {
    const modes = PROVIDER_MODES[providerId as ProviderId];
    if (providerId !== PROVIDER_IDS.OPENCODE || !catalogModes?.length) return modes;
    return [...modes, ...catalogModes.map(opencodeCatalogMode)];
  }
  const declared = catalogModes?.length
    ? catalogModes
    : (getCatalogProviderMetadata(providerId)?.modes ?? []);
  return declared.map(catalogProviderMode);
}

function opencodeCatalogMode(mode: RuntimeProviderModeOption): ProviderMode {
  return {
    ...UNKNOWN_MODE_STYLE,
    id: mode.id,
    label: mode.label,
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
  catalogModes?: readonly RuntimeProviderModeOption[],
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
  catalogModes?: readonly RuntimeProviderModeOption[],
): ProviderMode | null {
  return getProviderModes(providerId, catalogModes).find((m) => m.id === modeId) ?? null;
}

/**
 * Whether a session on `providerId` can hold `modeId`: a catalog mode, or an
 * OpenCode custom agent (those come from the live agent list, not the catalog).
 */
export function providerAcceptsMode(
  providerId: string | null | undefined,
  modeId: PermissionMode,
  catalogModes?: readonly RuntimeProviderModeOption[],
): boolean {
  return (
    !!findProviderMode(providerId, modeId, catalogModes) ||
    modeId.startsWith(OPENCODE_AGENT_MODE_PREFIX)
  );
}

/**
 * Whether the init replay may send `modeId` to a session on `providerId`.
 * Built-in adapters resolve a mode they can't hold to their own default, so
 * they always get the replay; catalog-declared providers only get a mode
 * their catalog lists (never the built-in frontend fallback).
 */
export function canReplayPermissionMode(providerId: string, modeId: PermissionMode): boolean {
  return providerId in PROVIDER_MODES || providerAcceptsMode(providerId, modeId);
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
export function defaultEditModeFor(
  providerId: string | null | undefined,
  catalogModes?: readonly RuntimeProviderModeOption[],
): PermissionMode {
  return getProviderModes(providerId, catalogModes)[0]?.id ?? "acceptEdits";
}

/**
 * Compute the next mode in the Shift+Tab cycle. Wraps around the end of the
 * filtered list. Falls back to the current mode when the list has < 2 items.
 */
export function nextProviderMode(
  providerId: string | null | undefined,
  current: PermissionMode,
  enabledOptInIds: PermissionMode[] = [],
  catalogModes?: readonly RuntimeProviderModeOption[],
): PermissionMode {
  const visible = getVisibleModes(providerId, enabledOptInIds, catalogModes);
  if (visible.length < 2) return current;
  const idx = visible.findIndex((m) => m.id === current);
  if (idx === -1) return visible[0].id;
  return visible[(idx + 1) % visible.length].id;
}
