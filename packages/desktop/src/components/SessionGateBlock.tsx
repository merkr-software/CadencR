import { ExternalLinkIcon, ShieldAlertIcon } from "lucide-react";
import { memo, useCallback, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGetFeature } from "@/api/generated";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { SessionGateDetails } from "@/components/SessionGateDetails";
import type { SessionGateEnvelope } from "@/lib/session-gate";

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
  const title =
    featureQuery.data?.title ??
    gate.childFeatureTitle ??
    (featureQuery.isLoading ? "Loading conversation…" : `Session ${gate.childSessionId}`);
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
  const navigate = useNavigate();
  const openChild = useCallback((): void => {
    if (projectId !== undefined)
      navigateToFeatureIdOrHome(navigate, projectId, gate.childFeatureId);
  }, [gate.childFeatureId, navigate, projectId]);
  return (
    <aside className="mx-auto my-2 w-full max-w-[85%] overflow-hidden rounded-lg border border-amber-500/30 bg-amber-500/[0.035] shadow-sm">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/20 bg-amber-500/[0.055] px-3 py-2">
        <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          <ShieldAlertIcon className="size-3.5" aria-hidden="true" />
          <span className="text-[11px] font-semibold capitalize">Child {gate.kind}</span>
        </span>
        <button
          type="button"
          onClick={openChild}
          disabled={projectId === undefined}
          className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-foreground hover:text-primary disabled:pointer-events-none"
          title={lookupError ? "Child conversation could not be loaded" : "Open child conversation"}
        >
          <span className="max-w-64 truncate">
            {lookupError ? `${title} (title unavailable)` : title}
          </span>
          <ExternalLinkIcon
            className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
            aria-hidden="true"
          />
        </button>
        <span className="ml-auto rounded-full border border-border/70 bg-background/45 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
          Parent can respond
        </span>
      </header>
      <div className="px-3 py-2.5">
        <SessionGateDetails gate={gate} />
      </div>
      <footer className="border-t border-border/50 px-3 py-1.5 font-mono text-[9px] text-muted-foreground/80">
        Request {gate.requestId}
      </footer>
    </aside>
  );
});
