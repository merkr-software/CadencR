import { parseAskUserQuestions } from "@/lib/agent-question-parser";
import { agentQuestionOptionValue } from "@/types/agent-question";
import { getPermissionPreview } from "@/components/permission-preview";
import {
  FeaturePermissionAction,
  type FeatureGateDecision,
  type FeaturePendingGateResponse,
} from "@/api/generated";
import { normalizeGateKind, type SessionGateKind } from "@/lib/session-gate";
import { asRecord } from "@/stores/ws-envelope-payload-primitives";
import type { PendingKind } from "@/types/agent";

export interface PermissionOptionView {
  key: string;
  label: string;
  description?: string;
  decision: FeatureGateDecision;
}

export function effectiveGateKind(gate: FeaturePendingGateResponse): SessionGateKind {
  return normalizeGateKind(gate.kind, gate.payload);
}

export function gatePrompt(gate: FeaturePendingGateResponse): string | null {
  const kind = effectiveGateKind(gate);
  const payload = asRecord(gate.payload);
  if (!payload) return null;

  if (kind === "question") {
    const toolInput = asRecord(payload.tool_input);
    if (toolInput) {
      const questions = parseAskUserQuestions(toolInput);
      if (questions[0]?.question) return questions[0].question;
    }
    return null;
  }

  if (kind === "permission") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
    const preview =
      getPermissionPreview({
        preview: payload.preview,
        input: asRecord(payload.tool_input),
        fallbackToJson: false,
      }) ??
      (typeof payload.pattern === "string" && payload.pattern.trim()
        ? payload.pattern.trim()
        : null);
    if (preview && toolName) return `${toolName}: ${preview}`;
    if (preview) return preview;
    if (typeof payload.description === "string" && payload.description.trim()) {
      return payload.description.trim();
    }
    return toolName || null;
  }

  if (typeof payload.description === "string" && payload.description.trim()) {
    return payload.description.trim();
  }
  return null;
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
      const label =
        typeof option.label === "string" && option.label.trim()
          ? option.label.trim()
          : action.replaceAll("_", " ");
      return [
        {
          key: `${decisionRaw}-${index}`,
          label,
          description: typeof option.description === "string" ? option.description : undefined,
          decision: {
            type: "permission",
            action,
          },
        },
      ];
    });
  }

  if (kind === "question") {
    const toolInput = asRecord(payload.tool_input) ?? {};
    const questions = parseAskUserQuestions(toolInput);
    // Sidebar only answers simple single-select questions; complex forms open the chat.
    if (questions.length !== 1 || questions[0]?.multiSelect || !questions[0]?.options?.length) {
      return [];
    }
    return questions[0].options.map((option, index) => {
      const value = agentQuestionOptionValue(option);
      return {
        key: `q-${index}-${value}`,
        label: option.label,
        description: option.description,
        decision: {
          type: "question",
          answers: [[value]],
        },
      };
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

function permissionActionFromDecision(
  decision: string | null,
): (typeof FeaturePermissionAction)[keyof typeof FeaturePermissionAction] | null {
  if (decision === "allow_once") return FeaturePermissionAction.allow_once;
  if (decision === "allow_future") return FeaturePermissionAction.allow_always;
  if (decision === "deny") return FeaturePermissionAction.deny;
  return null;
}
