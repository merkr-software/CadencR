import { parseAskUserQuestions } from "@/lib/agent-question-parser";
import type { AgentQuestion } from "@/types/agent-question";
import { getPermissionPreview } from "@/components/permission-preview";
import {
  FeaturePermissionAction,
  type FeatureGateDecision,
  type FeaturePendingGateResponse,
} from "@/api/generated";
import { normalizeGateKind, type SessionGateKind } from "@/lib/session-gate";
import { asRecord } from "@/stores/ws-envelope-payload-primitives";
import type { PendingKind } from "@/types/agent";

type PermissionActionValue = (typeof FeaturePermissionAction)[keyof typeof FeaturePermissionAction];

export interface PermissionOptionView {
  key: string;
  label: string;
  description?: string;
  decision: FeatureGateDecision;
  /** Set for permission options: what the option does, whatever its label says. */
  action?: PermissionActionValue;
  /** The provider takes a message with this option (a deny asks what to do instead). */
  collectFeedback?: boolean;
}

const PERMISSION_FALLBACK_LABEL: Record<PermissionActionValue, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  deny: "Deny",
};

/** What a permission gate shows above its actions. */
interface PermissionContext {
  toolName: string | null;
  /** The command or path being requested; null when the payload carries none. */
  command: string | null;
  /** Why the agent asks: its own justification, muted context for the command. */
  justification: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function permissionContext(gate: FeaturePendingGateResponse): PermissionContext {
  const payload = asRecord(gate.payload) ?? {};
  const toolInput = asRecord(payload.tool_input);
  const command =
    getPermissionPreview({
      preview: payload.preview,
      input: toolInput,
      fallbackToJson: false,
    }) ?? nonEmptyString(payload.pattern);
  const justification =
    nonEmptyString(toolInput?.description) ??
    nonEmptyString(gate.last_assistant_text) ??
    nonEmptyString(payload.description);
  return {
    toolName: nonEmptyString(payload.tool_name),
    command: command?.trim() ? command : null,
    justification: justification && justification !== command?.trim() ? justification : null,
  };
}

export function effectiveGateKind(gate: FeaturePendingGateResponse): SessionGateKind {
  return normalizeGateKind(gate.kind, gate.payload);
}

/** What a plan's row says: it is read in the conversation, not answered from the sidebar. */
export const PLAN_READY_LABEL = "Plan ready for review";

/** The questions an `AskUserQuestion` request carries; empty for any other request. */
export function gateQuestions(gate: FeaturePendingGateResponse): AgentQuestion[] {
  const toolInput = asRecord(asRecord(gate.payload)?.tool_input);
  return toolInput ? parseAskUserQuestions(toolInput) : [];
}

export function gatePrompt(gate: FeaturePendingGateResponse): string | null {
  const kind = effectiveGateKind(gate);
  const payload = asRecord(gate.payload);
  if (!payload) return null;

  if (kind === "question") return gateQuestions(gate)[0]?.question || null;

  if (kind === "permission") {
    const { toolName, command } = permissionContext(gate);
    if (command && toolName) return `${toolName}: ${command}`;
    return command ?? nonEmptyString(payload.description) ?? toolName;
  }

  return nonEmptyString(payload.description);
}

/** `gatePrompt`, with a plan named by its label. */
export function sidebarGatePrompt(gate: FeaturePendingGateResponse): string | null {
  return effectiveGateKind(gate) === "plan" ? PLAN_READY_LABEL : gatePrompt(gate);
}

export function buildOptions(gate: FeaturePendingGateResponse): PermissionOptionView[] {
  const kind = effectiveGateKind(gate);
  const payload = asRecord(gate.payload);
  if (!payload) return [];

  if (kind === "permission") {
    const rawOptions = Array.isArray(payload.options) ? payload.options : [];
    return rawOptions.flatMap((raw, index) => {
      const option = asRecord(raw);
      if (!option) return [];
      const decisionRaw = typeof option.decision === "string" ? option.decision : null;
      const action = permissionActionFromDecision(decisionRaw);
      if (!action) return [];
      const label = nonEmptyString(option.label) ?? PERMISSION_FALLBACK_LABEL[action];
      return [
        {
          key: `${decisionRaw}-${index}`,
          label,
          description: typeof option.description === "string" ? option.description : undefined,
          decision: {
            type: "permission",
            action,
          },
          action,
          collectFeedback: option.collect_feedback === true,
        },
      ];
    });
  }

  return [];
}

/** The text color naming a pending request: primary for a question, amber otherwise. */
export const PENDING_KIND_TEXT_CLASS: Record<PendingKind, string> = {
  question: "text-primary",
  permission: "text-(--acc-yellow,var(--color-amber-400))",
};

/** Fold plan into permission for the 2-value live status badge. */
export function triggerPendingKind(
  liveKind: PendingKind | null | undefined,
  gateKind: SessionGateKind | null,
): PendingKind {
  if (gateKind === "question") return "question";
  if (gateKind === "permission" || gateKind === "plan") return "permission";
  return liveKind === "question" ? "question" : "permission";
}

function permissionActionFromDecision(decision: string | null): PermissionActionValue | null {
  if (decision === "allow_once") return FeaturePermissionAction.allow_once;
  if (decision === "allow_future") return FeaturePermissionAction.allow_always;
  if (decision === "deny") return FeaturePermissionAction.deny;
  return null;
}
