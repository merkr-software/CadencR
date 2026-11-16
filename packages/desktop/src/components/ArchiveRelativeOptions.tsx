import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { GitForkIcon, Undo2Icon } from "lucide-react";
import { useGetFeatureArchivePreview, type ArchiveRequest } from "@/api/generated";
import { CleanupOption } from "@/components/CleanupOption";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";

export type ArchiveRelativeSelection = Required<
  Pick<ArchiveRequest, "include_parent" | "include_descendants">
>;

interface ArchiveRelativeOptionsProps {
  open: boolean;
  featureId: number | undefined;
  disabled: boolean;
}

export interface ArchiveRelativeOptionsState {
  selection: ArchiveRelativeSelection;
  isPending: boolean;
  content: ReactElement;
  toggleParent: () => void;
  toggleDescendants: () => void;
}

export function useArchiveRelativeOptions({
  open,
  featureId,
  disabled,
}: ArchiveRelativeOptionsProps): ArchiveRelativeOptionsState {
  const [includeParent, setIncludeParent] = useState(false);
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const query = useGetFeatureArchivePreview(featureId ?? 0, {
    query: { enabled: open && featureId != null, retry: false, staleTime: 30_000 },
  });

  useEffect(() => {
    setIncludeParent(false);
    setIncludeDescendants(false);
  }, [open, featureId]);

  const parentCount = query.data?.parent_ids.length ?? 0;
  const descendantCount = query.data?.descendant_ids.length ?? 0;
  const canToggle = !disabled && !query.isFetching && query.error == null;
  const toggleParent = useCallback((): void => {
    if (canToggle && parentCount > 0) setIncludeParent((selected) => !selected);
  }, [canToggle, parentCount]);
  const toggleDescendants = useCallback((): void => {
    if (canToggle && descendantCount > 0) setIncludeDescendants((selected) => !selected);
  }, [canToggle, descendantCount]);

  const retry = useCallback((): void => void query.refetch(), [query.refetch]);
  const content = useMemo(
    () => (
      <ArchiveRelativeOptionsContent
        parentCount={parentCount}
        descendantCount={descendantCount}
        includeParent={includeParent}
        includeDescendants={includeDescendants}
        disabled={!canToggle}
        isLoading={query.isFetching}
        error={query.error}
        onRetry={retry}
        toggleParent={toggleParent}
        toggleDescendants={toggleDescendants}
      />
    ),
    [
      canToggle,
      descendantCount,
      includeDescendants,
      includeParent,
      parentCount,
      query.error,
      query.isFetching,
      retry,
      toggleDescendants,
      toggleParent,
    ],
  );

  return useMemo(
    () => ({
      selection: {
        include_parent: includeParent && parentCount > 0,
        include_descendants: includeDescendants && descendantCount > 0,
      },
      isPending: query.isFetching || query.error != null,
      content,
      toggleParent,
      toggleDescendants,
    }),
    [
      content,
      descendantCount,
      includeDescendants,
      includeParent,
      parentCount,
      query.error,
      query.isFetching,
      toggleDescendants,
      toggleParent,
    ],
  );
}

interface ArchiveRelativeOptionsContentProps {
  parentCount: number;
  descendantCount: number;
  includeParent: boolean;
  includeDescendants: boolean;
  disabled: boolean;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  toggleParent: () => void;
  toggleDescendants: () => void;
}

function ArchiveRelativeOptionsContent(props: ArchiveRelativeOptionsContentProps): ReactElement {
  if (props.isLoading) {
    return <p className="text-xs text-muted-foreground">Checking linked sessions…</p>;
  }
  if (props.error != null) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
      >
        <span>{apiErrorMessage(props.error, "Could not check linked sessions")}</span>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {props.parentCount > 0 && (
        <CleanupOption
          checked={props.includeParent}
          disabled={props.disabled}
          icon={<Undo2Icon className="size-4" />}
          label="Archive parent"
          shortcut="P"
          description="Also archive the direct parent session."
          onCheckedChange={props.toggleParent}
        />
      )}
      {props.descendantCount > 0 && (
        <CleanupOption
          checked={props.includeDescendants}
          disabled={props.disabled}
          icon={<GitForkIcon className="size-4" />}
          label={`Archive ${props.descendantCount} descendant${props.descendantCount === 1 ? "" : "s"}`}
          shortcut="C"
          description="Also archive every active descendant session."
          onCheckedChange={props.toggleDescendants}
        />
      )}
    </div>
  );
}
