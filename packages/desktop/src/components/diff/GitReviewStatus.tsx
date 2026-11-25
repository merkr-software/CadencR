import { useUiTranslation } from "@/lib/i18n/ui";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { formatCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import type { ReviewThreadSummary } from "@/lib/pr-review-threads";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";

export interface GitReviewStatusProps {
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | undefined;
  summary: ReviewThreadSummary;
  activePosition: number;
  targetCount: number;
  onRetry: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

/**
 * Persistent review context for the branch diff. It never lets a slow, failed,
 * or clean request collapse into the same silent empty state.
 */
export function GitReviewStatus(props: GitReviewStatusProps): ReactElement {
  if (props.errorMessage) return <ReviewError {...props} />;
  if (props.isLoading && props.summary.total === 0) return <ReviewLoading />;
  return <ReviewSummary {...props} />;
}

function ReviewLoading(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground"
    >
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      {t("workspace.git.gitReviewStatus.loadingReviewFeedback", "Loading review feedback…")}
    </div>
  );
}

function ReviewError({ errorMessage, isRefreshing, onRetry }: GitReviewStatusProps): ReactElement {
  const { t } = useUiTranslation();
  const navigate = useNavigate();
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
    >
      <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-48 flex-1 break-words leading-snug">
        {t(
          "workspace.git.gitReviewStatus.reviewFeedbackUnavailable",
          "Review feedback unavailable:",
        )}
        {errorMessage}
      </p>
      <Button
        variant="outline"
        size="xs"
        disabled={isRefreshing}
        onClick={onRetry}
        className="border-destructive/40 bg-background/70"
      >
        {isRefreshing ? (
          <Loader2Icon className="size-3 animate-spin" aria-hidden />
        ) : (
          <RefreshCwIcon className="size-3" aria-hidden />
        )}
        {t("workspace.git.gitReviewStatus.retry", "Retry")}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          void navigate({ to: "/settings", search: { section: FORGE_SETTINGS_ANCHOR } })
        }
      >
        <Settings2Icon className="size-3" aria-hidden />
        {t("workspace.git.gitReviewStatus.gitSettings", "Git settings")}
      </Button>
    </div>
  );
}

function ReviewSummary({
  isRefreshing,
  summary,
  activePosition,
  targetCount,
  onPrevious,
  onNext,
}: GitReviewStatusProps): ReactElement {
  const { t } = useUiTranslation();
  const clean = summary.total === 0;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/35 px-4 py-2 text-xs"
    >
      {clean ? (
        <CheckCircle2Icon className="size-3.5 text-[var(--acc-green)]" aria-hidden />
      ) : (
        <MessageSquareTextIcon className="size-3.5 text-primary" aria-hidden />
      )}
      <span className="font-medium text-foreground">
        {clean
          ? t("workspace.git.gitReviewStatus.noOpenReviewThreads", "No open review threads")
          : t(
              "workspace.git.gitReviewStatus.openThreads",
              "{{count, number}} open review threads",
              {
                count: summary.total,
                defaultValue_one: "{{count, number}} open review thread",
              },
            )}
      </span>
      {!clean && (
        <span className="flex flex-wrap items-center gap-1">
          <ReviewCount
            label={t("workspace.git.gitReviewStatus.inline", "inline")}
            count={summary.anchored}
          />
          <ReviewCount
            label={t("workspace.git.gitReviewStatus.general", "general")}
            count={summary.general}
          />
          <ReviewCount
            label={t("workspace.git.gitReviewStatus.outdated", "outdated")}
            count={summary.outdated}
          />
          <ReviewCount
            label={t("workspace.git.gitReviewStatus.automated", "automated")}
            count={summary.automated}
          />
        </span>
      )}
      {isRefreshing && (
        <Loader2Icon className="size-3 animate-spin text-muted-foreground" aria-hidden />
      )}
      {targetCount > 0 && (
        <ReviewThreadNavigation {...{ activePosition, targetCount, onPrevious, onNext }} />
      )}
    </div>
  );
}

function ReviewCount({ label, count }: { label: string; count: number }): ReactElement | null {
  if (count === 0) return null;
  return (
    <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px] text-muted-foreground">
      {count} {label}
    </Badge>
  );
}

function ReviewThreadNavigation({
  activePosition,
  targetCount,
  onPrevious,
  onNext,
}: Pick<
  GitReviewStatusProps,
  "activePosition" | "targetCount" | "onPrevious" | "onNext"
>): ReactElement {
  const { t } = useUiTranslation();
  const previousShortcut = useResolvedShortcut("git-previous-review-thread");
  const nextShortcut = useResolvedShortcut("git-next-review-thread");
  const previousKeys = useMemo(() => formatCombo(previousShortcut.keys), [previousShortcut.keys]);
  const nextKeys = useMemo(() => formatCombo(nextShortcut.keys), [nextShortcut.keys]);
  return (
    <div className="ml-auto flex items-center gap-1">
      <ShortcutTooltip
        label={t(
          "workspace.git.gitReviewStatus.previousUnresolvedReviewThread",
          "Previous unresolved review thread",
        )}
        keys={previousKeys}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onPrevious}
          aria-label={t(
            "workspace.git.gitReviewStatus.previousUnresolvedReviewThread",
            "Previous unresolved review thread",
          )}
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
      </ShortcutTooltip>
      <span className="min-w-16 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
        {activePosition > 0
          ? `${activePosition} / ${targetCount}`
          : t("workspace.git.gitReviewStatus.inlineCount", "{{count, number}} inline", {
              count: targetCount,
            })}
      </span>
      <ShortcutTooltip
        label={t(
          "workspace.git.gitReviewStatus.nextUnresolvedReviewThread",
          "Next unresolved review thread",
        )}
        keys={nextKeys}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNext}
          aria-label={t(
            "workspace.git.gitReviewStatus.nextUnresolvedReviewThread",
            "Next unresolved review thread",
          )}
        >
          <ChevronRightIcon aria-hidden />
        </Button>
      </ShortcutTooltip>
    </div>
  );
}
