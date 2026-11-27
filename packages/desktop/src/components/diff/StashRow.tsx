import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useCallback, useRef, useState, type ReactElement, type RefObject } from "react";
import { ArchiveRestoreIcon, Loader2Icon, PackageOpenIcon, Trash2Icon } from "lucide-react";
import { NumStat } from "@/components/NumStat";
import type { StashEntry } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "./DiffFileTreeHelpers";
import { StashDropConfirmationDialog } from "./StashDropConfirmationDialog";
import type {
  StashConflictHandler,
  StashConflictOpenHandler,
  StashMutationOperation,
} from "./stash-contracts";
import { stashRefPendingLabel, type StashMutationCoordinator } from "./useStashMutationCoordinator";
import { useStashMutations } from "./useStashMutations";

export const STASH_ROW_HEIGHT = 46;

export interface StashRowProps {
  featureId: number;
  stash: StashEntry;
  onOpen: (stash: StashEntry) => void;
  onConflicts?: StashConflictHandler;
  onOpenConflict?: StashConflictOpenHandler;
  onRefresh?: () => Promise<void>;
  coordinator: StashMutationCoordinator;
  active?: boolean;
}

export const StashRow = memo(function StashRow({
  featureId,
  stash,
  onOpen,
  onConflicts,
  onOpenConflict,
  onRefresh,
  coordinator,
  active = false,
}: StashRowProps): ReactElement {
  const { t } = useUiTranslation();
  const [dropConfirmationOpen, setDropConfirmationOpen] = useState(false);
  const dropButtonRef = useRef<HTMLButtonElement | null>(null);
  const actions = useStashMutations({
    featureId,
    stash,
    onConflicts,
    onOpenConflict,
    onRefresh,
    coordinator,
  });
  const blockedReason = actions.pendingOperation ? null : coordinator.blockedReason;

  const handleOpen = useCallback((): void => onOpen(stash), [onOpen, stash]);
  const handleApply = useCallback((): void => void actions.apply(), [actions]);
  const handlePop = useCallback((): void => void actions.pop(), [actions]);
  const handleDropRequest = useCallback((): void => setDropConfirmationOpen(true), []);
  const handleDropOpenChange = useCallback((open: boolean): void => {
    setDropConfirmationOpen(open);
    if (!open) queueMicrotask(() => dropButtonRef.current?.focus());
  }, []);
  const handleDropConfirm = useCallback(async (): Promise<void> => {
    const completed = await actions.drop();
    if (completed) handleDropOpenChange(false);
  }, [actions, handleDropOpenChange]);
  const handleDropConfirmClick = useCallback(
    (): void => void handleDropConfirm(),
    [handleDropConfirm],
  );

  return (
    <div
      style={{ height: STASH_ROW_HEIGHT }}
      className={cn(
        "group flex w-full items-stretch transition-colors hover:bg-accent/60",
        active && "bg-accent/70 ring-1 ring-inset ring-primary",
      )}
    >
      <button
        type="button"
        onClick={handleOpen}
        aria-current={active ? "true" : undefined}
        aria-label={t("workspace.git.stashRow.openRefMessage", "Open {{ref}}: {{message}}", {
          ref: stash.ref_name,
          message: stash.message,
        })}
        className="flex min-w-0 flex-1 items-center px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StashRowDetails stash={stash} />
      </button>

      <StashRowActions
        stash={stash}
        pendingOperation={actions.pendingOperation}
        blockedReason={blockedReason}
        dropButtonRef={dropButtonRef}
        onApply={handleApply}
        onPop={handlePop}
        onDropRequest={handleDropRequest}
      />

      <span className="sr-only" aria-live="polite">
        {actions.pendingOperation ? stashProgressLabel(actions.pendingOperation, t) : ""}
      </span>
      <StashDropConfirmationDialog
        open={dropConfirmationOpen}
        stash={stash}
        pending={actions.pendingOperation === "drop"}
        blocked={blockedReason !== null}
        onOpenChange={handleDropOpenChange}
        onConfirm={handleDropConfirmClick}
      />
    </div>
  );
});

interface StashRowActionsProps {
  stash: StashEntry;
  pendingOperation: StashMutationOperation | null;
  blockedReason: string | null;
  dropButtonRef: RefObject<HTMLButtonElement | null>;
  onApply: () => void;
  onPop: () => void;
  onDropRequest: () => void;
}

const StashRowActions = memo(function StashRowActions({
  stash,
  pendingOperation,
  blockedReason,
  dropButtonRef,
  onApply,
  onPop,
  onDropRequest,
}: StashRowActionsProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="group"
      aria-label={t(
        "workspace.git.stashRow.actionsForRefMessage",
        "Actions for {{ref}}: {{message}}",
        { ref: stash.ref_name, message: stash.message },
      )}
      className="mr-1 flex shrink-0 items-center gap-0.5"
    >
      <StashInlineAction
        operation="apply"
        stashRef={stash.ref_name}
        pendingOperation={pendingOperation}
        blockedReason={blockedReason}
        onClick={onApply}
      />
      <StashInlineAction
        operation="pop"
        stashRef={stash.ref_name}
        pendingOperation={pendingOperation}
        blockedReason={blockedReason}
        onClick={onPop}
      />
      <StashInlineAction
        buttonRef={dropButtonRef}
        operation="drop"
        stashRef={stash.ref_name}
        pendingOperation={pendingOperation}
        blockedReason={blockedReason}
        onClick={onDropRequest}
      />
    </div>
  );
});

interface StashInlineActionProps {
  operation: StashMutationOperation;
  stashRef: string;
  pendingOperation: StashMutationOperation | null;
  blockedReason: string | null;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

const ACTION_ICONS = {
  apply: ArchiveRestoreIcon,
  pop: PackageOpenIcon,
  drop: Trash2Icon,
} as const;

function stashActionLabel(
  operation: StashMutationOperation,
  ref: string,
  pending: boolean,
  t: UiTranslator,
): string {
  if (pending) return stashRefPendingLabel(operation, ref, t);
  switch (operation) {
    case "apply":
      return t("workspace.git.stashRow.applyRef", "Apply {{ref}}", { ref });
    case "pop":
      return t("workspace.git.stashRow.popRef", "Pop {{ref}}", { ref });
    case "drop":
      return t("workspace.git.stashRow.dropRef", "Drop {{ref}}", { ref });
  }
}

const ACTION_CLASS_NAMES: Record<StashMutationOperation, string> = {
  apply: "text-[var(--acc-green)] hover:bg-[var(--acc-green)]/15 hover:text-[var(--acc-green)]",
  pop: "text-[var(--acc-cyan)] hover:bg-[var(--acc-cyan)]/15 hover:text-[var(--acc-cyan)]",
  drop: "text-[var(--acc-red)] hover:bg-[var(--acc-red)]/15 hover:text-[var(--acc-red)]",
};

const StashInlineAction = memo(function StashInlineAction({
  operation,
  stashRef,
  pendingOperation,
  blockedReason,
  onClick,
  buttonRef,
}: StashInlineActionProps): ReactElement {
  const { t } = useUiTranslation();
  const Icon = ACTION_ICONS[operation];
  const isPending = pendingOperation === operation;
  const disabled = pendingOperation !== null || blockedReason !== null;

  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="xs"
      disabled={disabled}
      onClick={onClick}
      aria-label={stashActionLabel(operation, stashRef, isPending, t)}
      title={blockedReason ?? stashActionLabel(operation, stashRef, false, t)}
      className={cn("h-7 px-1.5 text-[10px] disabled:opacity-40", ACTION_CLASS_NAMES[operation])}
    >
      {isPending ? <Loader2Icon className="size-3 animate-spin" /> : <Icon className="size-3" />}
      {operation === "apply"
        ? t("workspace.git.stashRow.apply", "Apply")
        : operation === "pop"
          ? t("workspace.git.stashRow.pop", "Pop")
          : t("workspace.git.stashRow.drop", "Drop")}
    </Button>
  );
});

const StashRowDetails = memo(function StashRowDetails({
  stash,
}: {
  stash: StashEntry;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-mono text-xs text-primary">{stash.ref_name}</span>
        <span className="min-w-0 truncate text-xs text-foreground">{stash.message}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="shrink-0">{formatRelativeDate(stash.date, t)}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          {stash.files_changed}{" "}
          {stash.files_changed === 1
            ? t("workspace.git.stashRow.file", "file")
            : t("workspace.git.stashRow.files", "files")}
        </span>
        <NumStat
          additions={stash.additions}
          deletions={stash.deletions}
          className="shrink-0 text-[10px]"
        />
      </div>
    </div>
  );
});

function stashProgressLabel(operation: StashMutationOperation, t: UiTranslator): string {
  switch (operation) {
    case "apply":
      return t("workspace.git.stashRow.applyStashPending", "apply stash in progress");
    case "pop":
      return t("workspace.git.stashRow.popStashPending", "pop stash in progress");
    case "drop":
      return t("workspace.git.stashRow.dropStashPending", "drop stash in progress");
  }
}
