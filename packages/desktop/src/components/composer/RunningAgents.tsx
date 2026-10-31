import { memo, useMemo, type ReactElement } from "react";
import { BotIcon } from "lucide-react";
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

/**
 * The sub-agents at work in this conversation whose cards are out of view, so
 * what is running reads at a glance without scrolling the transcript; an
 * agent whose card shows on screen is left out, it already reads there. A
 * row scrolls the transcript to that agent's card; nothing else happens from
 * here.
 */
export const RunningAgents = memo(function RunningAgents(): ReactElement | null {
  const { featureId, sessionId } = useComposerContext();
  const runs = useRunningSubagents(featureId, sessionId);
  const { onScreen, reveal } = useSubagentCards();
  const offScreen = useMemo(
    () => runs.filter((run) => !onScreen.has(run.toolUseId)),
    [onScreen, runs],
  );
  // Counted in the fold while any agent runs, listed or not: were its place
  // to come and go with the cards on screen, the fold would change the
  // transcript's height, which changes the cards on screen…
  const fold = useSectionFold(runs.length > 0, false);
  if (offScreen.length === 0) return null;
  return (
    <StackSection
      tone="agents"
      label="Running agents"
      data-composer-running-agents
      icon={<BotIcon />}
      title="Running agents"
      count={offScreen.length}
      hint="Click one to find it in the conversation"
      summary={agentsSummary(offScreen)}
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

function agentsSummary(runs: readonly SubagentRun[]): string {
  const views = runs.map((run) => subagentView(run));
  const [first] = views;
  if (views.length === 1 && first.description) return `${first.title}: ${first.description}`;
  // Several agents often share a name (general-purpose): their tasks tell them apart.
  return views.map((view) => view.description ?? view.title).join(", ");
}

const NOT_LOADED = "That agent's card is not in the loaded conversation yet.";

const RunningAgentRow = memo(function RunningAgentRow({
  run,
  reveal,
}: {
  run: SubagentRun;
  reveal: (toolUseId: string) => boolean;
}): ReactElement {
  const view = useMemo(() => subagentView(run), [run]);
  const show = (): void => {
    if (!reveal(run.toolUseId)) toast.info(NOT_LOADED);
  };
  return (
    <li>
      <button
        type="button"
        onClick={show}
        title="Show it in the conversation"
        aria-label={`Show ${view.title}${view.description ? `: ${view.description}` : ""} in the conversation`}
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
