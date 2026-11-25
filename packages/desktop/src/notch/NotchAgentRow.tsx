import type { UiTranslator } from "@/lib/i18n/ui";
import { memo, type CSSProperties } from "react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import type { NotchAgent } from "@/shared/notch";
import { formatElapsed } from "@/lib/format-elapsed";
import { formatAge } from "./notch-format";
import { ActionIcon, NotchTile } from "./NotchTile";

interface NotchAgentRowProps {
  agent: NotchAgent;
  t: UiTranslator;
  locale: string;
  index: number;
  now: number;
  onOpen: (agent: NotchAgent) => void;
  onDismiss: (agent: NotchAgent) => void;
}

function Aside({ agent, t, locale, now, onDismiss }: Omit<NotchAgentRowProps, "index" | "onOpen">) {
  if (agent.status === "running") {
    return agent.turnStartedAtMs != null ? (
      <span className="row-timer">{formatElapsed(now - agent.turnStartedAtMs)}</span>
    ) : null;
  }
  if (agent.status === "question") {
    return (
      <span className="row-chip" data-kind={agent.pendingKind ?? "question"}>
        {agent.pendingKind === "permission"
          ? t("notch.row.permission", "Permission")
          : t("notch.row.question", "Question")}
      </span>
    );
  }
  return (
    <>
      {agent.unread ? (
        <span className="row-unread" aria-label={t("notch.unread", "Unread")} />
      ) : null}
      {agent.lastActivityAtMs != null ? (
        <span className="row-age">{formatAge(now - agent.lastActivityAtMs, t, locale)}</span>
      ) : null}
      <span
        role="button"
        tabIndex={-1}
        className="row-dismiss"
        aria-label={t("notch.row.clear", "Clear from the notch")}
        onClick={(event) => {
          event.stopPropagation();
          onDismiss(agent);
        }}
      >
        <XIcon size={13} strokeWidth={2.2} aria-hidden="true" />
      </span>
    </>
  );
}

/** Second line: what a working agent is doing, or what a finished one said. */
function Detail({ agent, t }: Pick<NotchAgentRowProps, "agent" | "t">): React.JSX.Element | null {
  if (agent.status === "done") {
    return agent.preview ? <p className="row-preview">{agent.preview}</p> : null;
  }
  if (agent.status === "question" && !agent.lastAction) {
    return (
      <div className="row-action">
        <span className="row-action-text">
          {agent.pendingKind === "permission"
            ? t("notch.row.waitingApproval", "Waiting for your approval")
            : t("notch.row.waitingAnswer", "Waiting for your answer")}
        </span>
      </div>
    );
  }
  if (!agent.lastAction) {
    return (
      <div className="row-action">
        <span className="row-action-text shimmer">{t("notch.row.thinking", "Thinking…")}</span>
      </div>
    );
  }
  return (
    <div className="row-action">
      <ActionIcon kind={agent.lastAction.kind} />
      <span className={agent.status === "running" ? "row-action-text shimmer" : "row-action-text"}>
        {agent.lastAction.label}
      </span>
    </div>
  );
}

export const NotchAgentRow = memo(function NotchAgentRow({
  agent,
  t,
  locale,
  index,
  now,
  onOpen,
  onDismiss,
}: NotchAgentRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="row"
      data-status={agent.status}
      style={{ "--i": Math.min(index, 8) } as CSSProperties}
      onClick={() => onOpen(agent)}
    >
      <NotchTile agent={agent} t={t} />
      <span className="row-main">
        <span className="row-head">
          <span className="row-title">
            {agent.title ?? t("notch.untitledConversation", "Untitled conversation")}
          </span>
          {agent.projectName ? <span className="row-project">{agent.projectName}</span> : null}
        </span>
        <Detail agent={agent} t={t} />
      </span>
      <span className="row-aside">
        <Aside agent={agent} t={t} locale={locale} now={now} onDismiss={onDismiss} />
        <ChevronRightIcon className="row-open" strokeWidth={2.2} aria-hidden="true" />
      </span>
    </button>
  );
});
