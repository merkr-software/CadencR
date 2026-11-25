import { translateUi } from "@/lib/i18n/ui";
import { memo, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  useListProviderConversations,
  useStartProviderImport,
  type ImportConversationSummary,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { ImportConversationList, type ImportConversationSelection } from "./ImportConversationList";
import type { ProviderId } from "@/lib/providers";

interface ImportConversationPickerStepProps {
  projectId: number;
  providerId: ProviderId;
  providerLabel: string;
  onBack: () => void;
  onStarted: (jobId: string) => void;
}

/**
 * Lists provider conversations found on disk for the active project path.
 * The user filters by title, ticks rows, and clicks Import. Already-imported
 * sessions render as checked + disabled.
 */
function ImportConversationPickerStepInner({
  projectId,
  providerId,
  providerLabel,
  onBack,
  onStarted,
}: ImportConversationPickerStepProps) {
  const { data, isLoading, isError, error, refetch } = useListProviderConversations(
    projectId,
    providerId,
  );
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  const conversations: ImportConversationSummary[] = data?.conversations ?? [];

  const selection = useMemo(
    () => deriveSelectionState(conversations, query, selectedIds),
    [conversations, query, selectedIds],
  );

  const startMutation = useStartProviderImport({
    mutation: {
      onSuccess: (resp) => onStarted(resp.job_id),
      onError: (err) =>
        toast.error(
          apiErrorMessage(
            err,
            translateUi(
              "conversation.importConversationPickerStep.failedToStartImport",
              "Failed to start import",
            ),
          ),
        ),
    },
  });

  const toggle = useCallback((id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /**
   * Toggle every visible selectable row. If anything is selected, the first
   * click clears them (matches the indeterminate-state mental model); a
   * second click selects all.
   */
  const toggleAllVisible = useCallback((): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selection.selectAllState === true) {
        for (const id of selection.visibleSelectableIds) next.delete(id);
      } else {
        for (const id of selection.visibleSelectableIds) next.add(id);
      }
      return next;
    });
  }, [selection]);

  const handleImport = useCallback((): void => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    startMutation.mutate({ id: projectId, provider: providerId, data: { session_ids: ids } });
  }, [projectId, providerId, selectedIds, startMutation]);

  return (
    <ImportConversationList
      conversations={conversations}
      error={error}
      isError={isError}
      isImporting={startMutation.isPending}
      isLoading={isLoading}
      onBack={onBack}
      onImport={handleImport}
      onQueryChange={setQuery}
      onRefetch={refetch}
      onToggle={toggle}
      onToggleAll={toggleAllVisible}
      providerLabel={providerLabel}
      query={query}
      selectedIds={selectedIds}
      selection={selection}
    />
  );
}

function deriveSelectionState(
  conversations: ImportConversationSummary[],
  query: string,
  selectedIds: ReadonlySet<string>,
): ImportConversationSelection {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations;
  const visibleSelectableIds: string[] = [];
  let visibleSelectedCount = 0;
  for (const c of filtered) {
    if (c.already_imported) continue;
    visibleSelectableIds.push(c.source_session_id);
    if (selectedIds.has(c.source_session_id)) visibleSelectedCount += 1;
  }
  const selectedCount = selectedIds.size;
  const selectAllState: boolean | "indeterminate" =
    visibleSelectableIds.length > 0 && visibleSelectedCount === visibleSelectableIds.length
      ? true
      : visibleSelectedCount > 0
        ? "indeterminate"
        : false;
  return { filtered, visibleSelectableIds, selectedCount, selectAllState };
}

export const ImportConversationPickerStep = memo(ImportConversationPickerStepInner);
