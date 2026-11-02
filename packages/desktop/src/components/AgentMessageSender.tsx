import { useNavigate } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { memo, useCallback, type ReactElement } from "react";
import { useGetFeature, type AgentMessageOrigin, type Feature } from "@/api/generated";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { formatStreamTimestamp } from "@/lib/date-utils";
import { ProviderIcon } from "@/lib/provider-icons";
import { usePointSidebarFeature } from "@/hooks/usePointSidebarFeature";

interface AgentMessageSenderProps {
  origin: AgentMessageOrigin;
  /** When the message was sent; the tab replaces the stream's "User · time" line. */
  sentAt?: string;
}

/**
 * The sender tab of a message another conversation's agent sent: an "Agent"
 * eyebrow, that conversation's provider mark and title, then the time.
 * Pointing at the title lights the conversation up in the sidebar; a click
 * opens it.
 */
export const AgentMessageSender = memo(function AgentMessageSender({
  origin,
  sentAt,
}: AgentMessageSenderProps): ReactElement {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="shrink-0 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
        Agent
      </span>
      <SenderName origin={origin} />
      {sentAt && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatStreamTimestamp(sentAt)}
        </span>
      )}
    </span>
  );
});

function SenderName({ origin }: { origin: AgentMessageOrigin }): ReactElement {
  const sourceFeatureId = origin.sourceFeatureId ?? 0;
  const featureQuery = useGetFeature(sourceFeatureId, {
    query: { enabled: Boolean(origin.sourceFeatureId) },
  });
  const feature = featureQuery.data;

  if (featureQuery.isLoading) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
        Loading sender…
      </span>
    );
  }
  if (feature) return <SourceConversationButton feature={feature} note={origin.note} />;

  const tooltip = [
    featureQuery.isError ? "Conversation could not be loaded" : null,
    origin.note,
  ].filter((part): part is string => Boolean(part));
  return (
    <span className="truncate font-medium text-foreground" title={tooltip.join(" · ") || undefined}>
      {origin.sourceSessionId ? `Session ${origin.sourceSessionId}` : "Another conversation"}
    </span>
  );
}

function SourceConversationButton({
  feature,
  note,
}: {
  feature: Feature;
  note: string | null | undefined;
}): ReactElement {
  const navigate = useNavigate();
  const point = usePointSidebarFeature(feature.id);
  const openConversation = useCallback((): void => {
    navigateToFeatureIdOrHome(navigate, feature.project_id, feature.id);
  }, [feature.id, feature.project_id, navigate]);

  return (
    <button
      type="button"
      onClick={openConversation}
      {...point}
      className="-my-0.5 inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title={["Sent by this conversation's agent — open it", note].filter(Boolean).join(" · ")}
      aria-label={`Sent by ${feature.title}. Open conversation`}
    >
      <ProviderIcon
        providerId={feature.runtime_provider}
        alt=""
        variant="mono"
        className="size-3 shrink-0"
      />
      <span className="truncate">{feature.title}</span>
    </button>
  );
}
