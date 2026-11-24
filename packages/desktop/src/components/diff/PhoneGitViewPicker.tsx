import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { CheckIcon, ChevronDownIcon, Loader2Icon, type LucideIcon } from "lucide-react";
import { memo, useState, type ReactElement } from "react";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuTrigger,
} from "@/components/PhoneSheetMenu";
import { PR_TONE_DOT, type PrIndicatorTone } from "@/components/PrStatusIndicators";
import { useDelayedPending } from "@/hooks/useDelayedPending";
import { cn } from "@/lib/utils";
import type { GitViewMode } from "./GitTabToggle";
import {
  GIT_VIEW_SPINNER_DELAY_MS,
  gitTargetLabel,
  gitViews,
  type GitViewDefinition,
} from "./gitViews";

export interface PhoneGitViewPickerProps {
  value: GitViewMode;
  onChange: (value: GitViewMode) => void;
  targetBranch: string | undefined;
  prLabel: string | undefined;
  prNumber: number | undefined;
  prTone: PrIndicatorTone;
  uncommittedCount: number | undefined;
  conflictCount: number;
  pendingViewMode: GitViewMode | null;
}

interface ViewRow {
  mode: GitViewMode;
  icon: LucideIcon;
  label: string;
  /** A count or a state shown after the label, if any. */
  detail?: string;
  detailTone?: "danger" | "muted";
  dot?: PrIndicatorTone;
}

/** A view's row: its live name and count, as the desktop strip shows them. */
function viewRow(
  view: GitViewDefinition,
  t: UiTranslator,
  {
    targetBranch,
    prLabel = view.mode === "pr" ? view.label : "",
    prNumber,
    prTone,
    uncommittedCount,
    conflictCount,
  }: PhoneGitViewPickerProps,
): ViewRow {
  const base = { mode: view.mode, icon: view.icon, label: view.label };
  switch (view.mode) {
    case "uncommitted":
      return {
        ...base,
        detail:
          conflictCount > 0
            ? t("workspace.git.phoneGitViewPicker.conflicted", "{{count}} conflicted", {
                count: conflictCount,
              })
            : uncommittedCount
              ? String(uncommittedCount)
              : undefined,
        detailTone: conflictCount > 0 ? "danger" : "muted",
      };
    case "vs-target":
      return { ...base, label: gitTargetLabel(targetBranch, t) };
    case "pr":
      return {
        ...base,
        label: prNumber == null ? prLabel : `${prLabel} #${prNumber}`,
        dot: prNumber == null ? undefined : prTone,
      };
    default:
      return base;
  }
}

function RowDetail({ row }: { row: ViewRow }): ReactElement | null {
  if (row.dot) {
    return (
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", PR_TONE_DOT[row.dot])} />
    );
  }
  if (!row.detail) return null;
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[11px] tabular-nums",
        row.detailTone === "danger" ? "text-[var(--acc-red)]" : "text-muted-foreground",
      )}
    >
      {row.detail}
    </span>
  );
}

/**
 * The Git tab's view switch on the phone layout: one 44px button naming the
 * view on screen, which opens a sheet of the six views (44px rows, the
 * active one checked). Same views, same live counts and the same
 * `onChange` as the desktop strip (`GitTabToggle`).
 */
export const PhoneGitViewPicker = memo(function PhoneGitViewPicker(
  props: PhoneGitViewPickerProps,
): ReactElement {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const rows = gitViews(t).map((view) => viewRow(view, t, props));
  const current = rows.find((row) => row.mode === props.value) ?? rows[0];
  const slowPending = useDelayedPending(props.pendingViewMode, GIT_VIEW_SPINNER_DELAY_MS);
  if (!current) throw new Error("Git view rows are never empty");
  const CurrentIcon = slowPending === current.mode ? Loader2Icon : current.icon;
  return (
    <AdaptiveMenu open={open} onOpenChange={setOpen}>
      <AdaptiveMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("workspace.git.phoneGitViewPicker.currentView", "Git view: {{view}}", {
            view: current.label,
          })}
          className="flex h-11 min-w-0 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <CurrentIcon
            className={cn("size-4 shrink-0", slowPending === current.mode && "animate-spin")}
            aria-hidden
          />
          <span className="min-w-0 truncate">{current.label}</span>
          <RowDetail row={current} />
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent
        sheetTitle={t("workspace.git.phoneGitViewPicker.title", "Git view")}
        sheetTitleVisible
      >
        {rows.map((row) => {
          const Icon = row.icon;
          const active = row.mode === props.value;
          return (
            <AdaptiveMenuItem
              key={row.mode}
              aria-current={active ? "true" : undefined}
              onSelect={() => props.onChange(row.mode)}
            >
              <Icon className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <RowDetail row={row} />
              <CheckIcon className={cn("size-4", !active && "invisible")} aria-hidden />
            </AdaptiveMenuItem>
          );
        })}
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
});
