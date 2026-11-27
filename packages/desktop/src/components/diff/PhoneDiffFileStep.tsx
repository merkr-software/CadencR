import { useState, type ReactElement, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import type { ChangedFile } from "@/api/generated";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuTrigger,
} from "@/components/PhoneSheetMenu";
import { Button } from "@/components/ui/button";
import { displayGitPath } from "@/lib/git-display-path";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import type { GitFileActionEntry } from "./gitFileActions";
import { splitGitPath } from "./PhoneDiffFileList";

const BAR_BUTTON = "size-11 shrink-0 rounded-none text-muted-foreground hover:text-foreground";

export interface PhoneDiffFileActions {
  /** The desktop tree's file actions (`gitFileActions`), in its order. */
  entries: readonly GitFileActionEntry[];
  /** Absent where viewed state is not kept (a commit's diff). */
  viewed?: { isViewed: boolean; pending: boolean; mark: () => void; unmark: () => void };
}

/** The "…" sheet of the file on screen: what its desktop header row and context menu hold. */
function FileActionsMenu({
  file,
  actions,
}: {
  file: ChangedFile;
  actions: PhoneDiffFileActions;
}): ReactElement {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const { entries, viewed } = actions;
  const shownPath = displayGitPath(file.file);
  return (
    <AdaptiveMenu open={open} onOpenChange={setOpen}>
      <AdaptiveMenuTrigger asChild>
        <Button
          variant="ghost"
          className={BAR_BUTTON}
          aria-label={t("workspace.git.phoneDiffFileStep.actionsForPath", "Actions for {{path}}", {
            path: shownPath,
          })}
        >
          <MoreHorizontalIcon />
        </Button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent sheetTitle={shownPath} sheetTitleVisible>
        {entries.map((entry) => {
          if (entry.kind === "note") {
            return (
              <p key={entry.id} role="note" className="px-4 py-2 text-xs text-muted-foreground">
                {entry.text}
              </p>
            );
          }
          const Icon = entry.icon;
          return (
            <AdaptiveMenuItem key={entry.id} disabled={entry.disabled} onSelect={entry.run}>
              <Icon className={cn(entry.pending && "animate-spin")} /> {entry.label}
            </AdaptiveMenuItem>
          );
        })}
        {viewed && (
          <AdaptiveMenuItem
            disabled={viewed.pending}
            onSelect={viewed.isViewed ? viewed.unmark : viewed.mark}
          >
            {viewed.isViewed ? <EyeOffIcon /> : <EyeIcon />}
            {viewed.isViewed
              ? t("workspace.git.phoneDiffFileStep.markNotViewed", "Mark as not viewed")
              : t("workspace.git.phoneDiffFileStep.markViewed", "Mark as viewed")}
          </AdaptiveMenuItem>
        )}
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
}

interface PhoneDiffFileStepProps {
  file: ChangedFile;
  /** Names the list Back returns to: "Changes", "vs main", "Files". */
  backLabel: string;
  position: { index: number; total: number };
  onBack: () => void;
  onStep: (offset: -1 | 1) => void;
  actions: PhoneDiffFileActions;
  /** The file's diff (the shared `DiffContent`, with this one file). */
  children: ReactNode;
}

/**
 * The phone layout's second Git step: one file's diff full width under a
 * 44px row (Back to the list, the file's name, previous / next file, "…").
 * The diff's own header row is hidden here: the row and its sheet hold it.
 */
export function PhoneDiffFileStep({
  file,
  backLabel,
  position,
  onBack,
  onStep,
  actions,
  children,
}: PhoneDiffFileStepProps): ReactElement {
  const { t } = useUiTranslation();
  const { name } = splitGitPath(file.file);
  const { index, total } = position;
  return (
    <div className="flex h-full min-h-0 flex-col" data-phone-diff-step={file.file}>
      <div className="flex h-11 shrink-0 items-center border-b border-border">
        <Button
          variant="ghost"
          onClick={onBack}
          className="h-11 max-w-[40%] shrink-0 gap-1 rounded-none px-3 font-normal text-muted-foreground"
          aria-label={t("workspace.git.phoneDiffFileStep.backTo", "Back to {{label}}", {
            label: backLabel,
          })}
        >
          <ArrowLeftIcon className="size-4" />
          <span className="truncate">{backLabel}</span>
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={file.file}>
          {name}
        </span>
        <Button
          variant="ghost"
          className={BAR_BUTTON}
          aria-label={t("workspace.git.phoneDiffFileStep.previousFile", "Previous file")}
          disabled={index <= 0}
          onClick={() => onStep(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          className={BAR_BUTTON}
          aria-label={t("workspace.git.phoneDiffFileStep.nextFile", "Next file")}
          disabled={index >= total - 1}
          onClick={() => onStep(1)}
        >
          <ChevronRightIcon />
        </Button>
        <FileActionsMenu file={file} actions={actions} />
      </div>
      {/* The single-file diff hides its own header row (copy path, editor,
          stage, viewed: all in "…"); its stage error and conflict banner stay. */}
      <div className="min-h-0 flex-1 overflow-hidden [&_[data-diff-file-header]]:hidden">
        {children}
      </div>
    </div>
  );
}
