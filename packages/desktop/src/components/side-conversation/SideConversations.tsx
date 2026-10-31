import { memo, useMemo, type ReactElement } from "react";
import { ArrowUpRight, CircleAlert, Loader2, MessagesSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentStreamItem } from "@/components/agent-session/AgentStreamItem";
import { CompactFlowRow } from "@/components/agent-session/CompactFlowRow";
import { useAgentDisplayItems } from "@/components/useAgentStreamData";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useSessionStatus } from "@/stores/session-status-selectors";
import { useSideConversations, type SideConversation } from "@/stores/side-conversation-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { LiveAgentStatus } from "@/types/agent";
import { StackSection } from "@/components/composer/ComposerStack";
import { withoutBrief } from "./side-conversation-blocks";
import { useSideConversationActions } from "./useSideConversationActions";
import { useSideConversationSession } from "./useSideConversationSession";

interface SideConversationsProps {
  sourceSessionId: number;
  cwd: string;
}

/**
 * The side questions asked from this conversation (`/cadencr:side`), sections
 * of the composer card's stack: each a temporary mini-conversation that
 * answers next to the thread without entering it, until the user keeps it as
 * a thread of its own or closes it.
 */
export const SideConversations = memo(function SideConversations({
  sourceSessionId,
  cwd,
}: SideConversationsProps): ReactElement | null {
  const conversations = useSideConversations(sourceSessionId);
  if (conversations.length === 0) return null;
  return (
    <>
      {conversations.map((conversation) => (
        <SideConversationPanel
          key={conversation.featureId}
          sourceSessionId={sourceSessionId}
          conversation={conversation}
          cwd={cwd}
        />
      ))}
    </>
  );
});

/** Where the answer stands, after the question on the folded line. */
const SUMMARY_STATE: Record<LiveAgentStatus, string> = {
  agent: "answering…",
  question: "waiting for you",
  idle: "answered",
};

/** The header and actions; the streamed answer re-renders on its own. */
const SideConversationPanel = memo(function SideConversationPanel({
  sourceSessionId,
  conversation,
  cwd,
}: {
  sourceSessionId: number;
  conversation: SideConversation;
  cwd: string;
}): ReactElement {
  const status = useSessionStatus(conversation.sessionId)?.status ?? "idle";
  const live = status !== "idle";
  const wsSessionId = wsSessionIdFromFeature(conversation.featureId);
  // A live agent can only be stopped once this window has joined its session.
  const joined = useWsSessionStore(
    (state) => (state.sessions[wsSessionId]?.serverSessionId ?? "") !== "",
  );
  const actions = useSideConversationActions(sourceSessionId, conversation, live);
  return (
    <StackSection
      tone="side"
      label={`Side question: ${conversation.question}`}
      data-side-conversation
      icon={<MessagesSquare />}
      title="Side question"
      hint={<span title={conversation.question}>{conversation.question}</span>}
      headerClassName="pr-0"
      summary={`${conversation.question} · ${SUMMARY_STATE[status]}`}
      actions={
        <>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            title="Keep it as a conversation of its own, listed in the sidebar"
            onClick={() => void actions.keep()}
            disabled={actions.keeping}
          >
            {actions.keeping ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <ArrowUpRight className="size-3" aria-hidden />
            )}
            Keep as thread
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={live ? "Stop and close the side question" : "Close the side question"}
            title={live ? (joined ? "Stop and close" : "Connecting…") : "Close"}
            onClick={actions.close}
            disabled={live && !joined}
          >
            <X className="size-3.5" />
          </Button>
        </>
      }
    >
      <SideAnswer featureId={conversation.featureId} cwd={cwd} status={status} />
    </StackSection>
  );
});

function SideAnswer({
  featureId,
  cwd,
  status,
}: {
  featureId: number;
  cwd: string;
  status: LiveAgentStatus;
}): ReactElement {
  const working = status === "agent";
  const { ws, persistedLoaded } = useSideConversationSession(featureId, cwd, status !== "idle");
  const answerBlocks = useMemo(() => withoutBrief(ws.rootBlocks), [ws.rootBlocks]);
  const { displayBlocks, displayItems } = useAgentDisplayItems(
    answerBlocks,
    true,
    working,
    working,
    "compact",
  );
  const streamingBlockId = working ? (displayBlocks.at(-1)?.id ?? null) : null;
  // Always on: a reply's markdown can still grow once the turn has ended.
  const { scrollRef, contentRef } = useStickToBottom(true);
  return (
    <div
      ref={scrollRef}
      data-rich-copy="true"
      className="max-h-[min(40vh,22rem)] min-h-0 overflow-y-auto rounded-md bg-background/60 px-2.5 py-1"
    >
      <div ref={contentRef}>
        {displayItems.map((item) =>
          item.kind === "flow" ? (
            <CompactFlowRow key={item.key} blocks={item.blocks} basePath={cwd} />
          ) : (
            <AgentStreamItem
              key={item.key}
              block={item.block}
              isStreaming={streamingBlockId === item.block.id}
              basePath={cwd}
              toolResultMap={ws.toolResultMap}
              verbosityMode="compact"
            />
          ),
        )}
        <SideAnswerStatus
          status={status}
          loaded={persistedLoaded}
          empty={displayItems.length === 0}
        />
      </div>
    </div>
  );
}

function SideAnswerStatus({
  status,
  loaded,
  empty,
}: {
  status: LiveAgentStatus;
  loaded: boolean;
  empty: boolean;
}): ReactElement | null {
  if (status === "question") {
    return (
      <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
        <CircleAlert className="size-3.5 shrink-0 text-[var(--acc-yellow)]" aria-hidden />
        The side agent is waiting for you. Keep it as a thread to answer it.
      </p>
    );
  }
  if (loaded && status === "idle") {
    return empty ? (
      <p className="py-1 text-xs text-muted-foreground">
        No answer yet. Keep it as a thread to see the whole conversation.
      </p>
    ) : null;
  }
  return (
    <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" role="status">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {empty ? "Reading the conversation…" : "Answering…"}
    </p>
  );
}
