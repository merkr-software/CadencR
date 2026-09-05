import { Loader2Icon } from "lucide-react";
import { capitalize } from "@/lib/utils";
import { AGENT_ICONS } from "../agent-icons";
import { AGENT_LABELS, COMPACTING_BADGE, STATUS_BADGE } from "./constants";
import type { AgentSessionProps } from "./types";
import { useTurnWorkingLabel } from "@/components/TurnWorkingLabel";

export function useAgentSessionDisplay(props: AgentSessionProps) {
  const { agentType, status, isCompacting = false, lifecycle, turnTiming, label, icon } = props;
  const isAgentWorking = status === "agent";
  const isTurnActive = status !== "idle";
  const timerLifecycle = isAgentWorking && !isCompacting ? lifecycle : undefined;
  const streamLifecycle = isAgentWorking ? lifecycle : undefined;
  const turnWorkingLabel = useTurnWorkingLabel(timerLifecycle, turnTiming);
  const workingLabel = isCompacting ? COMPACTING_BADGE.label : turnWorkingLabel;
  const badge = isCompacting
    ? COMPACTING_BADGE
    : isAgentWorking
      ? { ...STATUS_BADGE.agent, label: workingLabel }
      : STATUS_BADGE[status];
  const IconComponent = icon ?? AGENT_ICONS[agentType] ?? Loader2Icon;
  const displayLabel = label ?? AGENT_LABELS[agentType] ?? capitalize(agentType);
  return {
    isAgentWorking,
    isTurnActive,
    streamLifecycle,
    workingLabel,
    badge,
    IconComponent,
    displayLabel,
  };
}
