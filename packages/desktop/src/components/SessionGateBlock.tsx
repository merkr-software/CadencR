import { useUiTranslation } from "@/lib/i18n/ui";
import { CheckCircle2Icon, ExternalLinkIcon, ShieldAlertIcon } from "lucide-react";
import { memo, useCallback, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGetFeature } from "@/api/generated";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { sessionGateKindLabel, SessionGateDetails } from "@/components/SessionGateDetails";
import type { SessionGateEnvelope } from "@/lib/session-gate";
import { cn } from "@/lib/utils";
import { useSessionStatusStore } from "@/stores/session-status-store";

interface SessionGateBlockProps {
  gate: SessionGateEnvelope;
}

interface GatePresentationProps extends SessionGateBlockProps {
  title: string;
  projectId?: number;
  lookupError?: boolean;
}

export const SessionGateBlock = memo(function SessionGateBlock({
  gate,
}: SessionGateBlockProps): ReactElement {
  if (gate.childFeatureTitle && gate.childProjectId !== undefined) {
    return (
      <GatePresentation
        gate={gate}
        title={gate.childFeatureTitle}
        projectId={gate.childProjectId}
      />
    );
  }
  return <SessionGateLookup gate={gate} />;
});

const SessionGateLookup = memo(function SessionGateLookup({
  gate,
}: SessionGateBlockProps): ReactElement {
  const featureQuery = useGetFeature(gate.childFeatureId);
  const { t } = useUiTranslation();
  const title =
    featureQuery.data?.title ??
    gate.childFeatureTitle ??
    (featureQuery.isLoading
      ? t("conversation.composer.sessionGateBlock.loading", "Loading conversation…")
      : t("conversation.composer.sessionGateBlock.session", "Session {{id}}", {
          id: gate.childSessionId,
        }));
  return (
    <GatePresentation
      gate={gate}
      title={title}
      projectId={featureQuery.data?.project_id ?? gate.childProjectId}
      lookupError={featureQuery.isError}
    />
  );
});

const GatePresentation = memo(function GatePresentation({
  gate,
  title,
  projectId,
  lookupError = false,
}: GatePresentationProps): ReactElement {
  const { t } = useUiTranslation();
  const navigate = useNavigate();
  const [childStatus, hasStatusSnapshot] = useSessionStatusStore(
    useShallow((state) => [state.bySession[gate.childSessionId], state.hasSnapshot] as const),
  );
  const isPending =
    childStatus === undefined
      ? !hasStatusSnapshot
      : childStatus.status === "question" &&
        (childStatus.requestId === null ||
          childStatus.requestId === undefined ||
          childStatus.requestId === gate.requestId);
  const openChild = useCallback((): void => {
    if (projectId !== undefined)
      navigateToFeatureIdOrHome(navigate, projectId, gate.childFeatureId);
  }, [gate.childFeatureId, navigate, projectId]);
  return (
    <aside
      className={cn(
        "mx-auto my-2 w-full max-w-[85%] overflow-hidden rounded-lg border shadow-sm",
        isPending ? "border-amber-500/30 bg-amber-500/[0.035]" : "border-border/60 bg-muted/15",
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2",
          isPending ? "border-amber-500/20 bg-amber-500/[0.055]" : "border-border/50 bg-muted/20",
        )}
      >
        <span
          className={cn(
            "flex items-center gap-1.5",
            isPending ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
        >
          {isPending ? (
            <ShieldAlertIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
          )}
          <span className="text-[11px] font-semibold capitalize">
            {t("conversation.composer.sessionGateBlock.childGate", "Child {{kind}}", {
              kind: sessionGateKindLabel(t, gate.kind),
            })}
          </span>
        </span>
        <button
          type="button"
          onClick={openChild}
          disabled={projectId === undefined}
          className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-foreground hover:text-primary disabled:pointer-events-none"
          title={
            lookupError
              ? t(
                  "conversation.composer.sessionGateBlock.childConversationCouldNotBeLoaded",
                  "Child conversation could not be loaded",
                )
              : t(
                  "conversation.composer.sessionGateBlock.openChildConversation",
                  "Open child conversation",
                )
          }
        >
          <span className="max-w-64 truncate">
            {lookupError
              ? t(
                  "conversation.composer.sessionGateBlock.titleUnavailable",
                  "{{title}} (title unavailable)",
                  { title },
                )
              : title}
          </span>
          <ExternalLinkIcon
            className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
            aria-hidden="true"
          />
        </button>
        <span className="ml-auto rounded-full border border-border/70 bg-background/45 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
          {isPending
            ? t("conversation.composer.sessionGateBlock.parentCanRespond", "Parent can respond")
            : t("conversation.composer.sessionGateBlock.resolved", "Resolved")}
        </span>
      </header>
      <div className="px-3 py-2.5">
        <SessionGateDetails gate={gate} />
      </div>
      <footer className="border-t border-border/50 px-3 py-1.5 font-mono text-[9px] text-muted-foreground/80">
        {t("conversation.composer.sessionGateBlock.request", "Request {{id}}", {
          id: gate.requestId,
        })}
      </footer>
    </aside>
  );
});
