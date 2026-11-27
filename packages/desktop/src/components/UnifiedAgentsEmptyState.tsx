import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactElement, type ReactNode } from "react";
import { AlertTriangleIcon, SearchXIcon } from "lucide-react";
import { AgentIcon } from "@/components/AgentIcon";
import { EmptyState } from "@/components/EmptyState";
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
  const { t } = useUiTranslation();
  const keys = useShortcutKeys("agents-new-feature");
  return (
    <GridEmptyState
      icon={<AgentIcon className="size-5" aria-hidden />}
      title={t("agents.unifiedAgentsEmptyState.noAgentsYet", "No agents yet")}
      description={t(
        "agents.unifiedAgentsEmptyState.everyConversationYouStartInAProject",
        "Every conversation you start in a project appears here, with the ones that need you first.",
      )}
      action={
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <span>
            <UiTrans
              i18nKey="agents.overview.empty.start"
              defaults="Start one with <action>{{actionName}}</action>"
              values={{ actionName: t("agents.unifiedAgentsNewFeatureButton.new", "New") }}
              components={{ action: <span className="font-medium text-foreground" /> }}
            />
          </span>
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
  const { t } = useUiTranslation();
  return (
    <GridEmptyState
      icon={<SearchXIcon className="size-5" aria-hidden />}
      title={t(
        "agents.unifiedAgentsEmptyState.noAgentsMatchThisFilter",
        "No agents match this filter",
      )}
      description={
        canShowAll
          ? t(
              "agents.unifiedAgentsEmptyState.onlyAgentsActiveInTheChosenWindow",
              "Only agents active in the chosen window are shown.",
            )
          : t(
              "agents.unifiedAgentsEmptyState.loosenOrClearTheFilterToSee",
              "Loosen or clear the filter to see the others.",
            )
      }
      action={
        <Actions>
          {canShowAll && (
            <Button type="button" size="sm" variant="secondary" onClick={onShowAll}>
              {t("agents.unifiedAgentsEmptyState.showEveryAgent", "Show every agent")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={canShowAll ? "ghost" : "secondary"}
            onClick={onClearFilter}
          >
            {t("agents.unifiedAgentsEmptyState.clearFilter", "Clear filter")}
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
  const { t } = useUiTranslation();
  return (
    <GridEmptyState
      role="alert"
      icon={<AlertTriangleIcon className="size-5 text-(--acc-red)" aria-hidden />}
      title={t("agents.unifiedAgentsEmptyState.couldnTLoadAgents", "Couldn't load agents")}
      description={message}
      action={
        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
          {t("agents.unifiedAgentsEmptyState.tryAgain", "Try again")}
        </Button>
      }
    />
  );
});
