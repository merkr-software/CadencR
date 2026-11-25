import { translateUi, type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
import { memo, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getListFeaturesQueryKey, useGetImportJob, type SkipReason } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress-bar";

interface ImportProgressStepProps {
  jobId: string;
  projectId: number;
  onClose: () => void;
}

/**
 * Polls the import job status while running, then surfaces a summary card.
 * Invalidates the project's features list once on completion so the new
 * conversations appear in the sidebar without manual refresh.
 */
function ImportProgressStepInner({ jobId, projectId, onClose }: ImportProgressStepProps) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const finishedRef = useRef(false);

  const { data: job } = useGetImportJob(jobId, {
    query: {
      refetchInterval: (query) =>
        query.state.data && query.state.data.status !== "running" ? false : 750,
    },
  });

  const isFinal = job?.status === "done";

  useEffect(() => {
    if (!job || finishedRef.current || job.status === "running") return;
    finishedRef.current = true;
    // Scope the invalidation to this project's features list so we don't
    // refetch every feature-scoped query in the cache.
    void queryClient.invalidateQueries({
      queryKey: getListFeaturesQueryKey({ project_id: projectId, include_archived: true }),
    });
    const count = job.imported.length;
    if (count > 0) {
      toast.success(
        translateUi("conversation.importProgressStep.importedConversations", {
          count,
          defaultValue_one: "Imported {{count}} conversation",
          defaultValue_other: "Imported {{count}} conversations",
        }),
      );
    }
  }, [job, queryClient, projectId]);

  const total = job?.total ?? 0;
  const completed = job?.completed ?? 0;
  const importedCount = job?.imported.length ?? 0;
  const skippedCount = job?.skipped.length ?? 0;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">
          {isFinal
            ? t("conversation.importProgressStep.importComplete", "Import complete")
            : t(
                "conversation.importProgressStep.importingConversations",
                "Importing conversations…",
              )}
        </div>
        <ProgressBar completed={completed} total={total} />
      </div>

      {isFinal && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <SummaryStat
            label={t("conversation.importProgressStep.imported", "Imported")}
            value={importedCount}
          />
          <SummaryStat
            label={t("conversation.importProgressStep.skipped", "Skipped")}
            value={skippedCount}
          />
        </div>
      )}

      {isFinal && skippedCount > 0 && job && (
        <SkippedList items={job.skipped.slice(0, 50)} more={Math.max(0, skippedCount - 50)} />
      )}

      {isFinal && (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={onClose}>
            {t("conversation.importProgressStep.done", "Done")}
          </Button>
        </div>
      )}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

function SkippedList({
  items,
  more,
}: {
  items: { source_session_id: string; reason: SkipReason }[];
  more: number;
}) {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {t("conversation.importProgressStep.skippedSessions", "Skipped sessions")}
      </div>
      <ul className="space-y-0.5 text-[11px]">
        {items.map((s) => (
          <li key={s.source_session_id} className="flex items-center justify-between gap-2">
            <span className="truncate font-mono">{s.source_session_id.slice(0, 8)}</span>
            <span className="text-muted-foreground">{skipReasonLabel(s.reason, t)}</span>
          </li>
        ))}
        {more > 0 && (
          <li className="text-muted-foreground">
            {t("conversation.importProgressStep.moreSkipped", "…and {{count}} more", {
              count: more,
            })}
          </li>
        )}
      </ul>
    </div>
  );
}

function skipReasonLabel(reason: SkipReason, t: UiTranslator): string {
  switch (reason) {
    case "already_imported":
      return t("conversation.importProgressStep.alreadyImported", "Already imported");
    case "empty":
      return t("conversation.importProgressStep.empty", "Empty session");
    case "not_found":
      return t("conversation.importProgressStep.notFound", "Session not found");
    case "parse_error":
      return t("conversation.importProgressStep.parseError", "Could not read the session");
    case "db_error":
      return t("conversation.importProgressStep.databaseError", "Could not save the session");
  }
}

export const ImportProgressStep = memo(ImportProgressStepInner);
