import { memo, useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useGetFeature } from "@/api/generated";
import { useAgentSessionContext } from "@/components/agent-session/agent-session-context";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { ProviderMonoMark } from "@/components/SidebarProviderBadge";
import { SpawnedSessionPeek } from "@/components/SpawnedSessionPeek";
import {
  agentCardClassName,
  effortLabel,
  MetaItemList,
  type MetaItem,
} from "@/components/subagents/SubagentCardParts";
import { SubagentStatusGlyph } from "@/components/subagents/SubagentStatusGlyph";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCardStatusGlyph, waitingLabel } from "@/components/UnifiedAgentCardStatus";
import { useFeatureAttention } from "@/hooks/useFeatureAttention";
import { usePointSidebarFeature } from "@/hooks/usePointSidebarFeature";
import { apiErrorMessage } from "@/lib/api-errors";
import { useProviderMetadata } from "@/lib/provider-icons";
import { ATTENTION_LABEL } from "@/lib/sidebar-attention";
import {
  parseSpawnRequest,
  parseSpawnResult,
  spawnResultText,
  type SpawnRequest,
  type SpawnResult,
} from "@/lib/spawned-session";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import type { PendingKind } from "@/types/agent";
import type { AgentBlockData } from "@/types/agent-block";

type ProviderMeta = ReturnType<typeof useProviderMetadata>;

interface SpawnedSessionBlockProps {
  block: AgentBlockData;
  /** The call's tool result, once the spawn answered. */
  result?: AgentBlockData;
  basePath?: string;
}

/**
 * A conversation the agent spawned through Cadencr's project tools, drawn as a
 * sub-agent card. Unlike a provider sub-agent it wears its provider's mark (it
 * may run on another provider than its parent) and opens its own conversation
 * on click instead of unfolding in place.
 */
export const SpawnedSessionBlock = memo(function SpawnedSessionBlock({
  block,
  result,
  basePath,
}: SpawnedSessionBlockProps): ReactElement {
  const request = useMemo(
    () => parseSpawnRequest(block.toolName ?? "", block.toolArgs),
    [block.toolName, block.toolArgs],
  );
  const spawned = useMemo(
    () => (result && !result.isError ? parseSpawnResult(result.content) : null),
    [result],
  );
  if (spawned) {
    return <SpawnedConversationCard request={request} spawned={spawned} basePath={basePath} />;
  }
  if (result) {
    return (
      <PendingSpawnCard
        request={request}
        state="failed"
        error={spawnResultText(result.content) ?? "The conversation could not be created."}
      />
    );
  }
  return <UnansweredSpawnCard request={request} />;
});

/**
 * No answer yet. The parent's live state is the only signal: at work it is
 * starting the conversation, on a gate it most likely waits for this call's
 * approval, idle it ended without an answer (an interrupted turn).
 */
function UnansweredSpawnCard({ request }: { request: SpawnRequest }): ReactElement {
  const { featureId } = useAgentSessionContext();
  const { status, kind } = useFeatureStatus(featureId);
  const state = status === "agent" ? "starting" : status === "question" ? "waiting" : "stopped";
  return <PendingSpawnCard request={request} state={state} kind={kind} />;
}

type PendingState = "starting" | "waiting" | "stopped" | "failed";

function pendingLabel(state: PendingState, kind: PendingKind | null): string {
  if (state === "starting") return "Starting conversation";
  if (state === "waiting") return waitingLabel(kind);
  return state === "failed" ? "Could not start" : "Not started";
}

function PendingSpawnCard({
  request,
  state,
  kind = null,
  error,
}: {
  request: SpawnRequest;
  state: PendingState;
  kind?: PendingKind | null;
  error?: string;
}): ReactElement {
  const label = pendingLabel(state, kind);
  const provider = useProviderMetadata(request.provider, null, "mono");
  return (
    <section
      data-tool-family="task"
      aria-label={`Spawned conversation: ${label}`}
      className={agentCardClassName(state === "failed")}
    >
      <div className="flex h-8 min-w-0 items-center gap-2 px-3 text-xs">
        {state === "waiting" ? (
          <AgentCardStatusGlyph state="waiting" kind={kind} />
        ) : (
          <SubagentStatusGlyph status={state === "starting" ? "running" : state} label={label} />
        )}
        <ProviderMark provider={provider} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
          {request.title ?? "New conversation"}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      </div>
      <SpawnMetaLine
        provider={provider}
        // Unknown until the spawn answers: omitted rather than guessed.
        model={request.model}
        effort={request.thinkingLevel}
        trailing={
          error ? (
            <span className="line-clamp-2 whitespace-normal text-(--acc-red)" title={error}>
              {error}
            </span>
          ) : null
        }
      />
    </section>
  );
}

function SpawnedConversationCard({
  request,
  spawned,
  basePath,
}: {
  request: SpawnRequest;
  spawned: SpawnResult;
  basePath?: string;
}): ReactElement {
  const navigate = useNavigate();
  const { featureId } = spawned;
  const featureQuery = useGetFeature(featureId);
  const feature = featureQuery.data;
  const attention = useFeatureAttention(featureId);
  const { status, kind } = useFeatureStatus(featureId);
  const point = usePointSidebarFeature(featureId);
  const projectId = feature?.project_id ?? spawned.projectId;
  // A conversation that no longer loads (deleted) must not open onto nothing.
  const canOpen = projectId != null && !featureQuery.isError;
  const open = useCallback((): void => {
    if (projectId == null) return;
    navigateToFeatureIdOrHome(navigate, projectId, featureId);
  }, [featureId, navigate, projectId]);
  const title = feature?.title ?? request.title;
  const provider = useProviderMetadata(feature?.runtime_provider ?? request.provider, null, "mono");
  const statusLabel =
    attention.state === "waiting" ? waitingLabel(kind) : ATTENTION_LABEL[attention.state];
  return (
    <section
      data-tool-family="task"
      data-spawned-feature-id={featureId}
      aria-label={`Spawned conversation ${title ?? featureId}: ${statusLabel}`}
      className={agentCardClassName(attention.state === "failed")}
    >
      <button
        type="button"
        onClick={open}
        disabled={!canOpen}
        {...point}
        title={canOpen ? "Open this conversation" : undefined}
        aria-label={`Open conversation ${title ?? featureId} · ${statusLabel}`}
        className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-3 text-left text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
      >
        <span title={statusLabel} className="inline-flex shrink-0">
          <AgentCardStatusGlyph state={attention.state} kind={kind} />
        </span>
        <ProviderMark provider={provider} />
        {title ? (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
            {title}
          </span>
        ) : featureQuery.isLoading ? (
          <Skeleton className="h-3.5 min-w-0 flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
            Conversation {featureId}
          </span>
        )}
        {canOpen && (
          <ArrowUpRightIcon
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          />
        )}
      </button>
      <SpawnMetaLine
        provider={provider}
        model={feature?.model_session ?? request.model ?? "Default model"}
        effort={feature?.thinking_effort ?? request.thinkingLevel}
        project={spawned.crossProject ? spawned.projectName : null}
        trailing={spawnProblem(spawned, featureQuery.error)}
      />
      {!featureQuery.isError && (
        <SpawnedSessionPeek featureId={featureId} status={status} basePath={basePath} />
      )}
    </section>
  );
}

/** What went wrong after the spawn answered: the conversation is gone, or never got its prompt. */
function spawnProblem(spawned: SpawnResult, featureError: unknown): ReactElement | null {
  if (featureError) {
    return (
      <span
        className="truncate text-(--acc-red)"
        title={apiErrorMessage(featureError, "unknown error")}
      >
        Conversation unavailable
      </span>
    );
  }
  if (!spawned.dispatchError) return null;
  return (
    <span className="truncate text-(--acc-red)" title={spawned.dispatchError}>
      First prompt not sent
    </span>
  );
}

/**
 * The provider the conversation runs on: what sets it apart from a provider
 * sub-agent. Decorative: the meta line names the provider.
 */
function ProviderMark({ provider }: { provider: ProviderMeta }): ReactElement {
  return (
    <span
      aria-hidden="true"
      title={provider?.label}
      data-provider-mark="mono"
      className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
    >
      <ProviderMonoMark iconSrc={provider?.iconSrc} scale={provider?.monoIconScale} />
    </span>
  );
}

/** Provider, model and effort, so a cross-provider spawn reads at a glance. */
function SpawnMetaLine({
  provider,
  model,
  effort,
  project,
  trailing,
}: {
  provider: ProviderMeta;
  model: string | null | undefined;
  effort: string | null | undefined;
  project?: string | null;
  trailing: ReactNode;
}): ReactElement | null {
  const items: MetaItem[] = [];
  if (provider?.label) items.push({ key: "provider", node: <span>{provider.label}</span> });
  if (model?.trim()) {
    items.push({
      key: "model",
      node: <span className="truncate font-mono text-foreground/80">{model.trim()}</span>,
    });
  }
  if (effort) items.push({ key: "effort", node: <span>{effortLabel(effort)}</span> });
  if (project) items.push({ key: "project", node: <span className="truncate">in {project}</span> });
  if (trailing) items.push({ key: "trailing", node: trailing });
  return <MetaItemList items={items} className="px-3 pb-2 pl-[34px]" />;
}
