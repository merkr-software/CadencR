import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatExactNumber } from "@/lib/format-number";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { Fragment, useRef } from "react";
import type { NotchAgent, NotchSnoozeMinutes } from "@/shared/notch";
import { IndexDotsOrb, type OrbStatus } from "./IndexDotsOrb";
import { NotchAgentRow } from "./NotchAgentRow";
import { PanelSnooze } from "./NotchSnooze";
import { useNow } from "@/hooks/useNow";
import { useReportHeight } from "./useReportHeight";

/** One state for a group of agents: anyone waiting on you wins, then work, then news. */
export function aggregateOrbState(agents: readonly NotchAgent[]): OrbStatus {
  if (agents.some((agent) => agent.status === "question")) return "question";
  if (agents.some((agent) => agent.status === "running")) return "running";
  if (agents.some((agent) => agent.unread)) return "done";
  return "idle";
}

/** Rows arrive sorted by urgency; a hairline separates each band of it. */
function band(agent: NotchAgent): string {
  if (agent.status === "done") return agent.unread ? "unread" : "read";
  return agent.status;
}

/** Header facts in attention order; a tone marks the ones that want you. */
const BAND_FACTS = [
  { band: "question", tone: "tone-permission" },
  { band: "unread", tone: "tone-done" },
  { band: "running", tone: undefined },
  { band: "read", tone: undefined },
] as const;

function renderFact(fact: (typeof BAND_FACTS)[number]["band"], formattedCount: string) {
  const values = { formattedCount };
  const components = { total: <b /> };
  switch (fact) {
    case "question":
      return (
        <UiTrans
          i18nKey="notch.panel.waiting"
          defaults="<total>{{formattedCount}}</total> waiting"
          values={values}
          components={components}
        />
      );
    case "unread":
      return (
        <UiTrans
          i18nKey="notch.panel.unread"
          defaults="<total>{{formattedCount}}</total> unread"
          values={values}
          components={components}
        />
      );
    case "running":
      return (
        <UiTrans
          i18nKey="notch.panel.working"
          defaults="<total>{{formattedCount}}</total> working"
          values={values}
          components={components}
        />
      );
    case "read":
      return (
        <UiTrans
          i18nKey="notch.panel.done"
          defaults="<total>{{formattedCount}}</total> done"
          values={values}
          components={components}
        />
      );
  }
}

export function PanelEars({ agents }: { agents: readonly NotchAgent[] }): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  const parts = BAND_FACTS.flatMap(({ band: key, tone }) => {
    const count = agents.filter((agent) => band(agent) === key).length;
    if (count === 0) return [];
    return [
      <span key={key} className={tone}>
        {renderFact(key, formatExactNumber(count, locale))}
      </span>,
    ];
  });
  // Two facts fit beside the cutout; the most urgent ones win.
  const shown = parts.slice(0, 2);
  return (
    <>
      <span className="ear">
        <IndexDotsOrb state={aggregateOrbState(agents)} />
        <span className="brand-word">Cadencr</span>
      </span>
      <span className="ear ear-meta">
        {shown.length === 0
          ? t("notch.panel.allQuiet", "All quiet")
          : shown.map((part, i) => (
              <Fragment key={part.key}>
                {i > 0 ? " · " : null}
                {part}
              </Fragment>
            ))}
      </span>
    </>
  );
}

/**
 * The hover panel: every agent worth a glance, in the order it needs you
 * (waiting on you, unread reply, working, read) with a hairline between bands. Reports its natural height so
 * the island can spring to exactly fit it.
 */
export function NotchPanel({
  agents,
  active,
  error,
  onOpen,
  onDismiss,
  onHeight,
  snoozedUntil,
  onSnooze,
}: {
  agents: readonly NotchAgent[];
  active: boolean;
  error: string | null;
  onOpen: (agent: NotchAgent) => void;
  onDismiss: (agent: NotchAgent) => void;
  onHeight: (height: number) => void;
  snoozedUntil: number | null;
  onSnooze: (minutes: NotchSnoozeMinutes | null) => void;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(active && agents.some((agent) => agent.status !== "done"));
  const ageNow = useNow(active, 30_000);

  useReportHeight(ref, onHeight);

  return (
    <div ref={ref}>
      {error ? <div className="panel-error">{error}</div> : null}
      {agents.length === 0 ? (
        <div className="panel-empty">
          <IndexDotsOrb state="idle" size={30} />
          <div>
            <strong>{t("notch.panel.emptyTitle", "No agents at work")}</strong>
            <span>
              {t(
                "notch.panel.emptyDescription",
                "Start a conversation in Cadencr and it will live here while it runs.",
              )}
            </span>
          </div>
        </div>
      ) : (
        // Rows re-mount on every open so their staggered entrance replays.
        <div className="panel-list" key={active ? "open" : "closed"}>
          {agents.map((agent, index) => (
            <Fragment key={agent.featureId}>
              {index > 0 && band(agents[index - 1]!) !== band(agent) ? (
                <div className="panel-sep" />
              ) : null}
              <NotchAgentRow
                agent={agent}
                t={t}
                locale={locale}
                index={index}
                now={agent.status === "done" ? ageNow : now}
                onOpen={onOpen}
                onDismiss={onDismiss}
              />
            </Fragment>
          ))}
        </div>
      )}
      <div className="panel-foot">
        <PanelSnooze snoozedUntil={snoozedUntil} onSnooze={onSnooze} />
      </div>
    </div>
  );
}
