import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
/**
 * Searchable, virtualized branch picker. Repos can have hundreds of branches —
 * `frontend-performance.md` requires virtualization for any list whose size
 * scales with user data, so we render through `react-virtuoso` (already a
 * project dep — we don't add `@tanstack/react-virtual` just for this).
 *
 * The list itself is generic: {@link TargetBranchPicker} picks a branch's
 * compare target, {@link LinkBranchPicker} links a branch to the conversation.
 * Per `no-optimistic-updates.md` neither invalidates after success; the
 * backend's `git.status` push carries the change.
 */
import { useCallback, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  useLinkFeatureBranch,
  useListBranches,
  useUpdateTargetBranch,
  type BranchInfo,
} from "@/api/generated";
import { cn } from "@/lib/utils";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import { useBranchList, type BranchListRowContext } from "./BranchList";

interface BranchPickerProps {
  projectId: number;
  /** Highlighted as the current choice. */
  selected: string | null | undefined;
  onSelect: (name: string) => Promise<unknown>;
  /** Toast title when `onSelect` fails. */
  errorMessage: string;
}

function BranchPicker({
  projectId,
  selected,
  onSelect,
  errorMessage,
}: BranchPickerProps): ReactElement {
  const { t } = useUiTranslation();
  const branchesQuery = useListBranches({ project_id: projectId });
  const [query, setQuery] = useState("");
  const [pendingName, setPendingName] = useState<string | null>(null);

  const pick = useCallback(
    async (name: string): Promise<void> => {
      setPendingName(name);
      try {
        await onSelect(name);
      } catch (err) {
        toastError(err, errorMessage);
      } finally {
        setPendingName(null);
      }
    },
    [errorMessage, onSelect],
  );

  const onPickBranch = useCallback((b: BranchInfo) => void pick(b.name), [pick]);

  const renderRow = useCallback(
    ({ branch, isActive }: BranchListRowContext) => (
      <BranchRow
        branch={branch}
        isSelected={branch.name === selected}
        isActive={isActive}
        isPending={pendingName === branch.name}
        onSelect={() => pick(branch.name)}
      />
    ),
    [selected, pendingName, pick],
  );

  const branches = branchesQuery.data ?? [];
  const { list, onKeyDown } = useBranchList({
    branches,
    query,
    onPick: onPickBranch,
    renderRow,
    emptyState: (
      <p className="text-sm text-muted-foreground p-3 text-center">
        {t("workspace.git.branchPicker.noMatchingBranches", "No matching branches.")}
      </p>
    ),
  });

  return (
    <div className="flex flex-col">
      <div className="px-2 pt-2 pb-1.5 border-b">
        <Input
          variant="ghost"
          autoFocus
          placeholder={t("workspace.git.branchPicker.searchBranches", "Search branches…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-7"
        />
      </div>
      {branchesQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>{t("workspace.git.branchPicker.loadingBranches", "Loading branches…")}</span>
        </div>
      ) : branchesQuery.isError ? (
        <p className="text-sm text-destructive p-3">
          {apiErrorMessage(
            branchesQuery.error,
            translateUi(
              "workspace.git.branchPicker.failedToLoadBranches",
              "Failed to load branches.",
            ),
          )}
        </p>
      ) : (
        list
      )}
    </div>
  );
}

interface TargetBranchPickerProps {
  featureId: number;
  projectId: number;
  /** The conversation branch whose target this picks. */
  branch: string;
  currentTarget: string | null | undefined;
  onPicked: () => void;
}

/** Pick the compare target of one of the conversation's branches. */
export function TargetBranchPicker({
  featureId,
  projectId,
  branch,
  currentTarget,
  onPicked,
}: TargetBranchPickerProps): ReactElement {
  const { t } = useUiTranslation();
  const { mutateAsync } = useUpdateTargetBranch();
  const select = useCallback(
    async (name: string): Promise<void> => {
      if (name !== currentTarget) {
        await mutateAsync({ id: featureId, data: { target_branch: name, branch } });
      }
      onPicked();
    },
    [branch, currentTarget, featureId, mutateAsync, onPicked],
  );
  return (
    <BranchPicker
      projectId={projectId}
      selected={currentTarget}
      onSelect={select}
      errorMessage={t(
        "workspace.git.branchPicker.failedToUpdateTargetBranch",
        "Failed to update target branch.",
      )}
    />
  );
}

interface LinkBranchPickerProps {
  featureId: number;
  projectId: number;
  onLinked: () => void;
}

/** Link an existing branch to the conversation by hand. */
export function LinkBranchPicker({
  featureId,
  projectId,
  onLinked,
}: LinkBranchPickerProps): ReactElement {
  const { t } = useUiTranslation();
  const { mutateAsync } = useLinkFeatureBranch();
  const select = useCallback(
    async (name: string): Promise<void> => {
      await mutateAsync({ id: featureId, data: { branch: name } });
      onLinked();
    },
    [featureId, mutateAsync, onLinked],
  );
  return (
    <BranchPicker
      projectId={projectId}
      selected={null}
      onSelect={select}
      errorMessage={t(
        "workspace.git.branchPicker.failedToLinkTheBranch",
        "Failed to link the branch.",
      )}
    />
  );
}

interface BranchRowProps {
  branch: BranchInfo;
  isSelected: boolean;
  isActive: boolean;
  isPending: boolean;
  onSelect: () => void;
}

function BranchRow({
  branch,
  isSelected,
  isActive,
  isPending,
  onSelect,
}: BranchRowProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isPending}
      aria-label={
        branch.is_local
          ? t("workspace.git.branchPicker.selectBranchLocal", "Select local branch {{branch}}", {
              branch: branch.name,
            })
          : t("workspace.git.branchPicker.selectBranchRemote", "Select remote branch {{branch}}", {
              branch: branch.name,
            })
      }
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left hover:bg-accent disabled:opacity-50",
        isSelected && "bg-accent/50",
        isActive && "bg-accent",
      )}
    >
      <span className="flex-1 truncate font-mono text-xs">{branch.name}</span>
      {!branch.is_local && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          {t("workspace.git.branchPicker.remote", "remote")}
        </span>
      )}
      {branch.attached_feature_id != null && (
        <span className="text-[10px] text-muted-foreground">
          {t("workspace.git.branchPicker.usedByFeature", "in use by feature #{{number}}", {
            number: branch.attached_feature_id,
          })}
        </span>
      )}
      {isPending && <Loader2 className="size-3 animate-spin" />}
    </button>
  );
}
