import { Loader2Icon } from "lucide-react";
import { capitalize } from "@/lib/utils";
import { AGENT_ICONS } from "../agent-icons";
import { AGENT_LABELS, COMPACTING_BADGE, STATUS_BADGE } from "./constants";
import type { AgentSessionProps } from "./types";
import { createElement } from "react";
import { TurnWorkingText, useStableTurnClock } from "@/components/TurnWorkingLabel";

export function useAgentSessionDisplay(props: AgentSessionProps) {
  const { agentType, status, isCompacting = false, lifecycle, turnClock, label, icon } = props;
  const isAgentWorking = status === "agent";
  const isTurnActive = status !== "idle";
  const streamLifecycle = isAgentWorking ? lifecycle : undefined;
  // The elapsed-time label ticks at 1 Hz in its leaves (the header badge and
  // the stream cursor), never here: a tick at the session root re-rendered
  // the whole session and composer every second.
  const workingClock = useStableTurnClock(isAgentWorking && !isCompacting ? turnClock : null);
  const workingLabel = isCompacting ? COMPACTING_BADGE.label : STATUS_BADGE.agent.label;
  const badge = isCompacting
    ? COMPACTING_BADGE
    : isAgentWorking
      ? { ...STATUS_BADGE.agent, label: createElement(TurnWorkingText, { clock: workingClock }) }
      : STATUS_BADGE[status];
  const IconComponent = icon ?? AGENT_ICONS[agentType] ?? Loader2Icon;
  const displayLabel = label ?? AGENT_LABELS[agentType] ?? capitalize(agentType);
  return {
    isAgentWorking,
    isTurnActive,
    streamLifecycle,
    workingLabel,
    workingClock,
    badge,
    IconComponent,
    displayLabel,
  };
}
