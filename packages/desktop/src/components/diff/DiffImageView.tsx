import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
import { useQuery } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { customInstance } from "@/api/client";
import { CheckerboardBackdrop } from "@/components/editor/CheckerboardBackdrop";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatBytes } from "@/lib/diff-thresholds";
import { cn } from "@/lib/utils";
import { deriveChangeTypeFromStatus } from "./DiffStatusIcon";
import type { DiffMode } from "./useDiffData";

type ImageSide = "old" | "new";

interface DiffImageViewProps {
  featureId: number;
  filePath: string;
  oldFilePath?: string;
  status: string;
  mode: DiffMode;
  targetBranch?: string;
  commitSha?: string | null;
}

interface DiffImageRequest {
  feature_id: number;
  file_path: string;
  old_file_path?: string;
  side: ImageSide;
  mode: DiffMode;
  target_branch?: string;
  commit_sha?: string;
}

interface ImagePanelProps {
  request: DiffImageRequest;
  label: string;
  imagePath: string;
}

interface ImageDimensions {
  width: number;
  height: number;
}

function readDiffImage(request: DiffImageRequest, signal?: AbortSignal): Promise<Blob> {
  return customInstance<Blob>({
    url: "/api/git/diff-image",
    method: "GET",
    params: request,
    responseType: "blob",
    signal,
  });
}

const DiffImagePanel = memo(function DiffImagePanel(props: ImagePanelProps) {
  const { t, i18n } = useUiTranslation();
  const { label, request, imagePath } = props;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const query = useQuery({
    queryKey: ["/api/git/diff-image", request],
    queryFn: ({ signal }) => readDiffImage(request, signal),
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    setObjectUrl(null);
    setDimensions(null);
    setDecodeError(false);
    if (!query.data) return;
    const url = URL.createObjectURL(query.data);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [query.data]);

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>): void => {
    setDimensions({
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    });
  }, []);
  const handleError = useCallback((): void => setDecodeError(true), []);
  const error = decodeError
    ? t("workspace.git.diffImageView.failedToDecodeImage", "Failed to decode image")
    : query.error
      ? apiErrorMessage(
          query.error,
          translateUi("workspace.git.diffImageView.failedToLoadImage", "Failed to load image"),
        )
      : null;

  return (
    <section
      className="min-w-0 bg-[var(--editor-bg)]"
      aria-label={t("workspace.git.diffImageView.imagePanel", "{{label}} image", { label })}
    >
      <div className="flex h-8 items-center justify-between border-b border-border px-3 font-mono text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="truncate pl-3 text-muted-foreground">
          {dimensions ? `${dimensions.width} × ${dimensions.height} · ` : ""}
          {query.data ? formatBytes(query.data.size, t) : ""}
        </span>
      </div>
      <div className="relative h-72 max-h-[50vh] min-h-40">
        {error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
            {error}
          </div>
        ) : objectUrl ? (
          <CheckerboardBackdrop className="flex items-center justify-center p-4">
            <img
              src={objectUrl}
              alt={t("workspace.git.diffImageView.imageVersion", "{{label}} version of {{path}}", {
                label,
                path: imagePath,
              })}
              onLoad={handleLoad}
              onError={handleError}
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          </CheckerboardBackdrop>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            <span className="sr-only">
              {t("workspace.git.diffImageView.loadingImage", "Loading {{label}} image…", {
                label: label.toLocaleLowerCase(i18n.resolvedLanguage),
              })}
            </span>
          </div>
        )}
      </div>
    </section>
  );
});

function DiffImageViewImpl(props: DiffImageViewProps) {
  const { t } = useUiTranslation();
  const changeType = deriveChangeTypeFromStatus(props.status);
  const isAdded = changeType === "new";
  const isDeleted = changeType === "deleted";
  const isComparison = !isAdded && !isDeleted;
  const baseRequest = {
    feature_id: props.featureId,
    file_path: props.filePath,
    old_file_path: props.oldFilePath,
    mode: props.mode,
    target_branch: props.targetBranch,
    commit_sha: props.commitSha ?? undefined,
  };

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-px border-t border-border bg-border",
        isComparison && "md:grid-cols-2",
      )}
    >
      {!isAdded && (
        <DiffImagePanel
          request={{ ...baseRequest, side: "old" }}
          imagePath={props.oldFilePath ?? props.filePath}
          label={
            isDeleted
              ? t("workspace.git.diffImageView.deleted", "Deleted")
              : t("workspace.git.diffImageView.before", "Before")
          }
        />
      )}
      {!isDeleted && (
        <DiffImagePanel
          request={{ ...baseRequest, side: "new" }}
          imagePath={props.filePath}
          label={
            isAdded
              ? t("workspace.git.diffImageView.added", "Added")
              : t("workspace.git.diffImageView.after", "After")
          }
        />
      )}
    </div>
  );
}

export const DiffImageView = memo(DiffImageViewImpl);
