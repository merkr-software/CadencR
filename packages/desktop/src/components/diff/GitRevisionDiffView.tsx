import { ArrowLeftIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DiffViewer } from "./DiffViewer";
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";

interface GitRevisionDiffViewProps {
  featureId: number;
  revision: string;
  backLabel: string;
  label: string;
  message: string | undefined;
  onBack: () => void;
  trailingAction?: ReactNode;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
}

/** Shared frame for commit-like revisions opened from Git list views. */
export function GitRevisionDiffView({
  featureId,
  revision,
  backLabel,
  label,
  message,
  onBack,
  trailingAction,
  registerNavigationAdapter,
}: GitRevisionDiffViewProps): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={onBack}
          className="-ml-1.5 font-normal text-muted-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          {backLabel}
        </Button>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        {/* What the revision says leads; its id is the reference beside it. */}
        <span className="min-w-0 truncate text-xs font-medium text-foreground" title={message}>
          {message}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{label}</span>
        <span className="flex-1" />
        {trailingAction}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DiffViewer
          featureId={featureId}
          mode="worktree"
          commitSha={revision}
          registerNavigationAdapter={registerNavigationAdapter}
        />
      </div>
    </div>
  );
}
