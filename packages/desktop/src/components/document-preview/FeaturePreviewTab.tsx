/**
 * The feature layout's Preview tab: a read-only viewer for the document last
 * opened from the conversation (a file link, an agent-written file) or sent
 * here from the file tree. Renders through the same `DocumentPreview` the
 * Editor mounts for document files.
 */
import { memo, useCallback, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, RotateCwIcon, XIcon } from "lucide-react";
import { readDocumentQueryKey } from "@/lib/document-file";
import { getFileName } from "@/lib/file-language";
import { useDocumentPreviewStore } from "@/stores/document-preview-store";
import { DocumentToolButton } from "./DocumentChrome";
import { DocumentPreview } from "./DocumentPreview";

interface FeaturePreviewTabProps {
  featureId: number;
  projectId: number;
}

export const FeaturePreviewTab = memo(function FeaturePreviewTab({
  featureId,
  projectId,
}: FeaturePreviewTabProps): ReactElement {
  const filePath = useDocumentPreviewStore((state) => state.byFeature[featureId] ?? null);
  const queryClient = useQueryClient();

  const reload = useCallback(() => {
    if (!filePath) return;
    void queryClient.invalidateQueries({
      queryKey: readDocumentQueryKey(projectId, featureId, filePath),
      exact: true,
    });
  }, [featureId, filePath, projectId, queryClient]);
  const close = useCallback(() => useDocumentPreviewStore.getState().close(featureId), [featureId]);

  if (!filePath) return <PreviewEmptyState />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate" title={filePath}>
          <span className="text-foreground">{getFileName(filePath)}</span>
          {filePath.includes("/") && (
            <span className="ml-2 text-muted-foreground">
              {filePath.slice(0, filePath.lastIndexOf("/"))}
            </span>
          )}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <DocumentToolButton label="Reload from disk" onClick={reload}>
            <RotateCwIcon />
          </DocumentToolButton>
          <DocumentToolButton label="Close preview" onClick={close}>
            <XIcon />
          </DocumentToolButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DocumentPreview
          key={filePath}
          filePath={filePath}
          projectId={projectId}
          featureId={featureId}
        />
      </div>
    </div>
  );
});

function PreviewEmptyState(): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileTextIcon className="size-6 text-muted-foreground/60" />
      <p className="text-sm text-foreground">No document to preview</p>
      <p className="max-w-sm text-xs text-balance text-muted-foreground">
        PDF, Word, Excel, PowerPoint and CSV files open here when you click one in the conversation
        or choose “Open in Preview” in the file tree.
      </p>
    </div>
  );
}
