import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { ShieldAlertIcon, ClipboardCheck, MessageCircleQuestionIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { StackSection, type StackTone } from "./composer/ComposerStack";

type Kind = "permission" | "plan" | "question";

interface AgentPromptPendingIndicatorProps {
  kind: Kind;
  /** Optional contextual detail (e.g. tool name for permissions) */
  detail?: string;
}

interface KindStyle {
  icon: ReactNode;
  label: (t: UiTranslator) => string;
  /** Approvals wear the amber of "action required", questions the primary (as in the sidebar). */
  tone: StackTone;
}

const STYLES: Record<Kind, KindStyle> = {
  permission: {
    icon: <ShieldAlertIcon />,
    label: (t) =>
      t(
        "conversation.composer.agentPromptPendingIndicator.permissionPending",
        "Permission request pending",
      ),
    tone: "attention",
  },
  plan: {
    icon: <ClipboardCheck />,
    label: (t) =>
      t("conversation.composer.agentPromptPendingIndicator.planPending", "Plan approval pending"),
    tone: "attention",
  },
  question: {
    icon: <MessageCircleQuestionIcon />,
    label: (t) =>
      t("conversation.composer.agentPromptPendingIndicator.questionPending", "Question pending"),
    tone: "question",
  },
};

/**
 * A section of the composer's stack while a special prompt (permission, plan
 * approval, or question) is debounced behind the user's typing. It tells the
 * user the prompt is waiting without stealing focus or shortcuts.
 */
export function AgentPromptPendingIndicator({
  kind,
  detail,
}: AgentPromptPendingIndicatorProps): ReactElement {
  const { t } = useUiTranslation();
  const style = STYLES[kind];
  const { icon, tone } = style;
  const label = style.label(t);
  return (
    <StackSection
      tone={tone}
      label={label}
      role="status"
      icon={icon}
      title={label}
      hint={
        detail ? (
          <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[11px] text-foreground">
            {detail}
          </code>
        ) : undefined
      }
      actions={
        <span className="shrink-0 text-muted-foreground">
          {t(
            "conversation.composer.agentPromptPendingIndicator.finishTypingToReviewIt",
            "Finish typing to review it",
          )}
        </span>
      }
    />
  );
}
