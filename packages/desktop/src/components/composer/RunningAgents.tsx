import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useMemo, type ReactElement } from "react";
import { AgentIcon } from "@/components/AgentIcon";
import { toast } from "sonner";
import type { SubagentRun } from "@/api/generated";
import { useSubagentCards } from "@/components/agent-session/subagent-reveal";
import {
  ElapsedClock,
  SubagentBackgroundTag,
  SubagentIdentity,
  SubagentModelLabel,
} from "@/components/subagents/SubagentCardParts";
import { useRunningSubagents } from "@/hooks/useFeatureSubagents";
import { subagentView } from "@/lib/subagents/subagent-presentation";
import { useComposerContext } from "./ComposerContext";
import { STACK_ROW_BUTTON_CLASS, StackList, StackSection } from "./ComposerStack";
import { useSectionFold } from "./stack-fold";
import { useSettledOffScreen } from "./useSettledOffScreen";

/**
 * The sub-agents at work in this conversation whose cards are out of view, so
 * what is running reads at a glance without scrolling the transcript; an
 * agent whose card shows on screen is left out, it already reads there. An
 * agent joins the list only once its card has stayed out of view for a
 * moment: the list's height moves the transcript, so it must not follow
 * every frame a card dips out. A row scrolls the transcript to that agent's
 * card; nothing else happens from here.
 */
export const RunningAgents = memo(function RunningAgents(): ReactElement | null {
  const { t } = useUiTranslation();
  const { featureId, sessionId } = useComposerContext();
  const runs = useRunningSubagents(featureId, sessionId);
  const { onScreen, reveal } = useSubagentCards();
  const offScreenIds = useMemo(
    () => runs.map((run) => run.toolUseId).filter((id) => !onScreen.has(id)),
    [onScreen, runs],
  );
  // Listed once out of view for a moment, dropped at once (see the hook).
  const listed = useSettledOffScreen(offScreenIds);
  const offScreen = useMemo(() => runs.filter((run) => listed.has(run.toolUseId)), [listed, runs]);
  // Counted in the fold while any agent runs, listed or not: were its place
  // to come and go with the cards on screen, the fold would change the
  // transcript's height, which changes the cards on screen…
  const fold = useSectionFold(runs.length > 0, false);
  if (offScreen.length === 0) return null;
  return (
    <StackSection
      tone="agents"
      label={t("conversation.composer.runningAgents.runningAgents", "Running agents")}
      data-composer-running-agents
      icon={<AgentIcon />}
      title={t("conversation.composer.runningAgents.runningAgents", "Running agents")}
      count={offScreen.length}
      hint={t(
        "conversation.composer.runningAgents.clickOneToFindItInThe",
        "Click one to find it in the conversation",
      )}
      summary={agentsSummary(offScreen, t)}
      fold={fold}
    >
      <StackList>
        {offScreen.map((run) => (
          <RunningAgentRow key={run.toolUseId} run={run} reveal={reveal} />
        ))}
      </StackList>
    </StackSection>
  );
});

function agentsSummary(runs: readonly SubagentRun[], t: UiTranslator): string {
  const views = runs.map((run) => subagentView(run, undefined, t));
  const [first] = views;
  if (views.length === 1 && first.description) return `${first.title}: ${first.description}`;
  // Several agents often share a name (general-purpose): their tasks tell them apart.
  return views.map((view) => view.description ?? view.title).join(", ");
}

const RunningAgentRow = memo(function RunningAgentRow({
  run,
  reveal,
}: {
  run: SubagentRun;
  reveal: (toolUseId: string) => boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  const view = useMemo(() => subagentView(run, undefined, t), [run, t]);
  const show = (): void => {
    if (!reveal(run.toolUseId))
      toast.info(
        translateUi(
          "conversation.composer.runningAgents.cardNotLoaded",
          "That agent's card is not in the loaded conversation yet.",
        ),
      );
  };
  return (
    <li>
      <button
        type="button"
        onClick={show}
        title={t(
          "conversation.composer.runningAgents.showItInTheConversation",
          "Show it in the conversation",
        )}
        aria-label={t(
          "conversation.composer.runningAgents.showAgent",
          "Show {{agent}} in the conversation",
          { agent: view.description ? `${view.title}: ${view.description}` : view.title },
        )}
        className={STACK_ROW_BUTTON_CLASS}
      >
        <SubagentIdentity view={view} />
        {view.background && <SubagentBackgroundTag className="shrink-0 text-muted-foreground" />}
        <SubagentModelLabel
          view={view}
          className="hidden max-w-[8rem] shrink-0 text-[11px] text-muted-foreground @[32rem]:inline"
        />
        <ElapsedClock view={view} />
      </button>
    </li>
  );
});
