import { memo, type ReactElement } from "react";
import type { PrStatusSnapshot } from "@/api/generated";
import {
  effectiveGateKind,
  PENDING_KIND_TEXT_CLASS,
  sidebarGatePrompt,
  triggerPendingKind,
} from "@/components/sidebar-pending-gate";
import { useFeaturePendingGate } from "@/hooks/useFeaturePendingGate";
import { prAction, type NextActionKind } from "@/lib/next-actions";
import { cn } from "@/lib/utils";
import type { PendingKind } from "@/types/agent";
import { useFeatureStatus } from "@/stores/session-status-selectors";

type VerbTone = "permission" | "question" | "failed" | "quiet";

interface Verb {
  label: string;
  /** What the verb asks, in full: the line's tooltip when it names nothing more. */
  detail: string;
  tone: VerbTone;
  /** The action is about the conversation's pull request, named after the verb. */
  aboutPr?: true;
}

const VERBS: Record<Exclude<NextActionKind, "waiting">, Verb> = {
  failed: { label: "Check error", detail: "The agent stopped on an error", tone: "failed" },
  fix_ci: {
    label: "Fix CI",
    detail: "The pull request's checks are failing",
    tone: "quiet",
    aboutPr: true,
  },
  address_review: {
    label: "Address review",
    detail: "Changes were requested on the pull request",
    tone: "quiet",
    aboutPr: true,
  },
  review: { label: "Review", detail: "The agent finished: its reply is unread", tone: "quiet" },
  merge: {
    label: "Merge",
    detail: "The pull request is approved and its checks pass",
    tone: "quiet",
    aboutPr: true,
  },
};

const WAITING_VERBS: Record<"permission" | "question" | "unknown", Verb> = {
  permission: { label: "Approve", detail: "The agent asks for permission", tone: "permission" },
  question: { label: "Answer", detail: "The agent asks a question", tone: "question" },
  unknown: { label: "Respond", detail: "The agent waits on you", tone: "permission" },
};

/** Strong verbs take the status indicator's colors; the others stay quiet. */
const TONE_CLASS: Record<VerbTone, string> = {
  permission: cn("font-semibold", PENDING_KIND_TEXT_CLASS.permission),
  question: cn("font-semibold", PENDING_KIND_TEXT_CLASS.question),
  failed: "font-semibold text-(--acc-red)",
  quiet: "font-medium text-foreground/75",
};

/**
 * The verb for `kind` and its classes, without the request details: for
 * surfaces that name the action but don't fetch the pending request.
 */
export function nextActionVerb(
  kind: NextActionKind,
  pendingKind: PendingKind,
): { label: string; className: string } {
  const verb = kind === "waiting" ? WAITING_VERBS[pendingKind] : VERBS[kind];
  return { label: verb.label, className: TONE_CLASS[verb.tone] };
}

/**
 * What the "For me" block asks the user to do about a row, on its own line
 * under the title so the title keeps its width: the verb ("Approve", "Answer",
 * "Check error", "Fix CI", "Address review", "Review", "Merge"), then what it
 * is about when the row knows (the pending request, the pull request). Shows
 * in every density: naming the action is the block's point.
 */
export const SidebarNextActionLine = memo(function SidebarNextActionLine({
  kind,
  featureId,
  prStatus,
}: {
  kind: NextActionKind;
  /** The conversation the action is about: for a pending request, the one that asks. */
  featureId: number;
  prStatus: PrStatusSnapshot | undefined;
}): ReactElement {
  if (kind === "waiting") return <WaitingLine featureId={featureId} />;
  const verb = VERBS[kind];
  return (
    <ActionLine verb={verb} kind={kind} object={verb.aboutPr ? prObject(kind, prStatus) : null} />
  );
});

/**
 * "Approve" a permission (or plan), "Answer" a question, followed by the
 * request itself. Shares the gate popover's query, so answering from either
 * refreshes both. "Respond" while neither the request nor the live status
 * says which.
 */
function WaitingLine({ featureId }: { featureId: number }): ReactElement {
  const { kind: liveKind } = useFeatureStatus(featureId);
  const { gate, errorMessage } = useFeaturePendingGate({ featureId, enabled: true });
  const verb =
    WAITING_VERBS[
      gate || liveKind
        ? triggerPendingKind(liveKind, gate ? effectiveGateKind(gate) : null)
        : "unknown"
    ];
  // A plan is read in the conversation: the line only says it waits.
  const prompt = gate ? sidebarGatePrompt(gate) : null;
  return (
    <ActionLine
      verb={verb}
      kind="waiting"
      object={prompt ?? (errorMessage ? "Request details unavailable" : null)}
    />
  );
}

/** The pull request a PR action is about, and its first failing check when CI fails. */
function prObject(kind: NextActionKind, prStatus: PrStatusSnapshot | undefined): string | null {
  const action = prAction(prStatus);
  if (!action) return null;
  const failing = kind === "fix_ci" ? action.ci?.checks.find((c) => c.state === "failing") : null;
  return failing ? `#${action.pr.number} · ${failing.name}` : `#${action.pr.number}`;
}

function ActionLine({
  verb,
  kind,
  object,
}: {
  verb: Verb;
  kind: NextActionKind;
  object: string | null;
}): ReactElement {
  return (
    <span
      data-feature-next-action-line
      title={object ? `${verb.label}: ${object}` : verb.detail}
      className="flex min-w-0 items-baseline gap-1 text-[11px] leading-4"
    >
      <span
        data-feature-next-action={kind}
        className={cn("shrink-0 whitespace-nowrap", TONE_CLASS[verb.tone])}
      >
        {verb.label}
      </span>
      {object && <span className="min-w-0 truncate text-muted-foreground">{object}</span>}
    </span>
  );
}
