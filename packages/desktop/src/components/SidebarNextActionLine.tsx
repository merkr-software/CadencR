import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
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
  failed: {
    get label() {
      return translateUi("sidebar.nextAction.checkError", "Check error");
    },
    get detail() {
      return translateUi(
        "sidebar.nextAction.checkErrorDescription",
        "The agent stopped on an error",
      );
    },
    tone: "failed",
  },
  fix_ci: {
    get label() {
      return translateUi("sidebar.nextAction.fixCi", "Fix CI");
    },
    get detail() {
      return translateUi(
        "sidebar.nextAction.fixCiDescription",
        "The pull request's checks are failing",
      );
    },
    tone: "quiet",
    aboutPr: true,
  },
  address_review: {
    get label() {
      return translateUi("sidebar.nextAction.addressReview", "Address review");
    },
    get detail() {
      return translateUi(
        "sidebar.nextAction.addressReviewDescription",
        "Changes were requested on the pull request",
      );
    },
    tone: "quiet",
    aboutPr: true,
  },
  review: {
    get label() {
      return translateUi("sidebar.nextAction.review", "Review");
    },
    get detail() {
      return translateUi(
        "sidebar.nextAction.reviewDescription",
        "The agent finished: its reply is unread",
      );
    },
    tone: "quiet",
  },
  merge: {
    get label() {
      return translateUi("sidebar.nextAction.merge", "Merge");
    },
    get detail() {
      return translateUi(
        "sidebar.nextAction.mergeDescription",
        "The pull request is approved and its checks pass",
      );
    },
    tone: "quiet",
    aboutPr: true,
  },
};

const WAITING_VERBS: Record<"permission" | "question" | "unknown", Verb> = {
  permission: {
    get label() {
      return translateUi("sidebar.nextAction.approve", "Approve");
    },
    get detail() {
      return translateUi("sidebar.nextAction.approveDescription", "The agent asks for permission");
    },
    tone: "permission",
  },
  question: {
    get label() {
      return translateUi("sidebar.nextAction.answer", "Answer");
    },
    get detail() {
      return translateUi("sidebar.nextAction.answerDescription", "The agent asks a question");
    },
    tone: "question",
  },
  unknown: {
    get label() {
      return translateUi("sidebar.nextAction.respond", "Respond");
    },
    get detail() {
      return translateUi("sidebar.nextAction.respondDescription", "The agent waits on you");
    },
    tone: "permission",
  },
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

/** A next action as a surface shows it: its verb, what it is about, and how it is answered. */
export interface NextActionView {
  label: string;
  /** The verb's tone classes (amber, primary, red or quiet). */
  className: string;
  /** What the verb asks, in full: the line's tooltip when it names nothing more. */
  detail: string;
  /** What the action is about (the pending request, the pull request), when known. */
  object: string | null;
  /** A pending permission or question: the quick reply answers it (a plan never). */
  quickReply: boolean;
}

/**
 * A next action other than a pending request: the verb ("Check error", "Fix
 * CI", "Address review", "Review", "Merge") and the pull request it is about.
 * Pure: a row that waits on nothing subscribes to nothing.
 */
export function actionView(
  kind: Exclude<NextActionKind, "waiting">,
  prStatus: PrStatusSnapshot | undefined,
): NextActionView {
  const verb = VERBS[kind];
  return {
    label: verb.label,
    className: TONE_CLASS[verb.tone],
    detail: verb.detail,
    object: verb.aboutPr ? prObject(kind, prStatus) : null,
    quickReply: false,
  };
}

/**
 * A pending request: "Approve" a permission or plan, "Answer" a question, then
 * the request itself, fetched with the gate popover's query (answering from
 * either refreshes both). "Respond" while neither the request nor the live
 * status says which. Only a waiting row mounts it.
 */
export function useWaitingActionView(featureId: number): NextActionView {
  const { t } = useUiTranslation();
  const { kind: liveKind } = useFeatureStatus(featureId);
  const { gate, errorMessage } = useFeaturePendingGate({ featureId, enabled: true });
  const gateKind = gate ? effectiveGateKind(gate) : null;
  const verb = WAITING_VERBS[gate || liveKind ? triggerPendingKind(liveKind, gateKind) : "unknown"];
  // A plan is read in the conversation: the line only says it waits.
  const prompt = gate ? sidebarGatePrompt(gate) : null;
  return {
    label: verb.label,
    className: TONE_CLASS[verb.tone],
    detail: verb.detail,
    object:
      prompt ??
      (errorMessage
        ? t("sidebar.nextActionLine.requestDetailsUnavailable", "Request details unavailable")
        : null),
    quickReply: gateKind !== "plan",
  };
}

/**
 * What the "For me" block asks the user to do about a row, on its own line
 * under the title so the title keeps its width: the verb, then what it is
 * about when the row knows. Shows in every density: naming the action is the
 * block's point.
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
  return <ActionLine view={actionView(kind, prStatus)} kind={kind} />;
});

function WaitingLine({ featureId }: { featureId: number }): ReactElement {
  return <ActionLine view={useWaitingActionView(featureId)} kind="waiting" />;
}

/** The pull request a PR action is about, and its first failing check when CI fails. */
function prObject(kind: NextActionKind, prStatus: PrStatusSnapshot | undefined): string | null {
  const action = prAction(prStatus);
  if (!action) return null;
  const failing = kind === "fix_ci" ? action.ci?.checks.find((c) => c.state === "failing") : null;
  return failing ? `#${action.pr.number} · ${failing.name}` : `#${action.pr.number}`;
}

function ActionLine({ view, kind }: { view: NextActionView; kind: NextActionKind }): ReactElement {
  const { label, className, detail, object } = view;
  const { t } = useUiTranslation();
  return (
    <span
      data-feature-next-action-line
      title={
        object
          ? t("sidebar.nextAction.withObject", "{{action}}: {{object}}", {
              action: label,
              object,
            })
          : detail
      }
      className="flex min-w-0 items-baseline gap-1 text-[11px] leading-4"
    >
      <span data-feature-next-action={kind} className={cn("shrink-0 whitespace-nowrap", className)}>
        {label}
      </span>
      {object && <span className="min-w-0 truncate text-muted-foreground">{object}</span>}
    </span>
  );
}
