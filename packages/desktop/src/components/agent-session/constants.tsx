import { translateUi } from "@/lib/i18n/ui";
import { Loader2Icon, MessageCircleQuestionIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentType } from "../../types/agent-types";

export type { LiveAgentStatus as AgentStatus } from "@/types/agent";
import type { LiveAgentStatus as AgentStatus } from "@/types/agent";

export const AGENT_LABELS: Partial<Record<AgentType, string>> = {
  get session() {
    return translateUi("conversation.stream.status.session", "Session");
  },
  get auto_name() {
    return translateUi("conversation.stream.status.autoName", "Auto Rename");
  },
};

// 3-value status badge map. Mirrors the canonical `AgentStatus` enum
// pushed by the backend on `app/session_status.*`.
export const STATUS_BADGE: Record<
  AgentStatus,
  { label: string; className: string; icon?: React.ReactNode }
> = {
  idle: {
    get label() {
      return translateUi("conversation.stream.status.idle", "Idle");
    },
    className: "bg-gray-500/15 text-gray-400",
  },
  agent: {
    get label() {
      return translateUi("conversation.stream.status.working", "Working");
    },
    className: "bg-primary/15 text-primary",
    icon: <Loader2Icon className="size-3 animate-spin" />,
  },
  question: {
    get label() {
      return translateUi("conversation.stream.status.awaitingInput", "Awaiting input");
    },
    className: "bg-amber-500/15 text-amber-300",
    icon: <MessageCircleQuestionIcon className="size-3" />,
  },
};

// Backend-confirmed in-progress compaction badge.
export const COMPACTING_BADGE: { label: string; className: string; icon: ReactNode } = {
  get label() {
    return translateUi("conversation.stream.status.compacting", "Compacting…");
  },
  className: "bg-orange-500/15 text-orange-300",
  icon: <Loader2Icon className="size-3 animate-spin" />,
};
