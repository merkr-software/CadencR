import { cn } from "@/lib/utils";
import { useUiTranslation } from "@/lib/i18n/ui";

interface ProgressBarProps {
  completed: number;
  total: number;
  className?: string;
  indicatorClassName?: string;
  "aria-label"?: string;
  showCount?: boolean;
}

export function ProgressBar({
  completed,
  total,
  className,
  indicatorClassName,
  "aria-label": ariaLabel,
  showCount = true,
}: ProgressBarProps) {
  const { t } = useUiTranslation();
  if (total <= 0) return null;
  const safeCompleted = Math.min(Math.max(completed, 0), total);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="progressbar"
        aria-label={ariaLabel ?? t("common.progress", "Progress")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={safeCompleted}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-800"
      >
        <div
          className={cn(
            "h-full rounded-full bg-green-500 transition-all duration-300",
            indicatorClassName,
          )}
          style={{ width: `${(safeCompleted / total) * 100}%` }}
        />
      </div>
      {showCount && (
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {safeCompleted}/{total}
        </span>
      )}
    </div>
  );
}
