import { memo, type ReactElement, type ReactNode } from "react";
import { AlertTriangleIcon, BotIcon, SearchXIcon } from "lucide-react";
import { EmptyState } from "@/components/FeaturePrViewParts";
import { KbdShortcut } from "@/components/KbdShortcut";
import { Button } from "@/components/ui/button";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";

/** The shared empty state, filling the grid area and announced politely
 *  (an error assertively). */
function GridEmptyState({
  role = "status",
  ...props
}: Parameters<typeof EmptyState>[0] & { role?: "status" | "alert" }): ReactElement {
  return (
    <div role={role} className="min-h-0 flex-1">
      <EmptyState {...props} />
    </div>
  );
}

function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex items-center justify-center gap-2">{children}</div>;
}

/** Nothing to show yet: say where agents come from and how to start one. */
export const UnifiedAgentsNoAgents = memo(function UnifiedAgentsNoAgents(): ReactElement {
  const keys = useShortcutKeys("agents-new-feature");
  return (
    <GridEmptyState
      icon={<BotIcon className="size-5" aria-hidden />}
      title="No agents yet"
      description="Every conversation you start in a project appears here, with the ones that need you first."
      action={
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          Start one with <span className="font-medium text-foreground">New</span>
          <KbdShortcut keys={keys} variant="hint" />
        </p>
      }
    />
  );
});

/** The filter hides everything: offer the ways back. */
export const UnifiedAgentsNoMatches = memo(function UnifiedAgentsNoMatches({
  canShowAll,
  onClearFilter,
  onShowAll,
}: {
  canShowAll: boolean;
  onClearFilter: () => void;
  onShowAll: () => void;
}): ReactElement {
  return (
    <GridEmptyState
      icon={<SearchXIcon className="size-5" aria-hidden />}
      title="No agents match this filter"
      description={
        canShowAll
          ? "Only agents active in the chosen window are shown."
          : "Loosen or clear the filter to see the others."
      }
      action={
        <Actions>
          {canShowAll && (
            <Button type="button" size="sm" variant="secondary" onClick={onShowAll}>
              Show every agent
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={canShowAll ? "ghost" : "secondary"}
            onClick={onClearFilter}
          >
            Clear filter
          </Button>
        </Actions>
      }
    />
  );
});

export const UnifiedAgentsLoadError = memo(function UnifiedAgentsLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <GridEmptyState
      role="alert"
      icon={<AlertTriangleIcon className="size-5 text-(--acc-red)" aria-hidden />}
      title="Couldn't load agents"
      description={message}
      action={
        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
});
