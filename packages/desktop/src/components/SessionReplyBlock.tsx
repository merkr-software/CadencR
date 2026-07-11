import { CircleAlertIcon, CircleCheckIcon, MessageSquareReplyIcon } from "lucide-react";
import { memo, useCallback, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Markdown } from "@/components/Markdown";
import { useGetFeature } from "@/api/generated";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { cn } from "@/lib/utils";
import type { SessionReplyEnvelope } from "@/lib/session-reply";

interface SessionReplyBlockProps {
  reply: SessionReplyEnvelope;
}

export const SessionReplyBlock = memo(function SessionReplyBlock({
  reply,
}: SessionReplyBlockProps): ReactElement {
  const navigate = useNavigate();
  const needsFeatureLookup = !reply.responderFeatureTitle || reply.responderProjectId === undefined;
  const featureQuery = useGetFeature(reply.responderFeatureId, {
    query: { enabled: needsFeatureLookup },
  });
  const isFailed = reply.status === "failed";
  const subject = reply.link === "spawned" ? "Spawned session" : "Session";
  const featureTitle = featureQuery.data?.title ?? reply.responderFeatureTitle;
  const projectId = featureQuery.data?.project_id ?? reply.responderProjectId;
  const responder = featureTitle
    ? `“${featureTitle}”`
    : featureQuery.isLoading
      ? "Loading conversation…"
      : `Session ${reply.responderSessionId} (title unavailable)`;
  const outcome = isFailed ? "failed" : reply.link === "spawned" ? "completed" : "replied";
  const StatusIcon = isFailed ? CircleAlertIcon : CircleCheckIcon;
  const openConversation = useCallback((): void => {
    if (projectId === undefined) return;
    navigateToFeatureIdOrHome(navigate, projectId, reply.responderFeatureId);
  }, [navigate, projectId, reply.responderFeatureId]);

  return (
    <div className="mx-auto my-2 flex w-full max-w-[85%] flex-col items-center gap-1.5">
      <div className="flex w-full items-center gap-3" aria-label={`${subject} ${outcome}`}>
        <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <MessageSquareReplyIcon className="size-3" aria-hidden="true" />
          <span>{subject}</span>
          {projectId === undefined ? (
            <span
              title={featureQuery.isError ? "Conversation title could not be loaded" : undefined}
            >
              {responder}
            </span>
          ) : (
            <button
              type="button"
              onClick={openConversation}
              className="rounded-sm text-foreground/75 underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-[var(--acc-cyan)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              title="Open conversation"
            >
              {responder}
            </button>
          )}
          <span>{outcome}</span>
          <StatusIcon
            className={cn("size-3", isFailed ? "text-destructive/80" : "text-emerald-500/80")}
            aria-hidden="true"
          />
        </div>
        <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
      </div>
      <div className="w-full rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <Markdown content={reply.body} className="session-reply-markdown" />
      </div>
    </div>
  );
});
