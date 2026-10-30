import { useEffect, useLayoutEffect, useMemo, type ReactElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { getGetMessageFullContentQueryKey, useGetMessageFullContent } from "@/api/generated";
import { suppressAutoScrollPin } from "@/lib/agent-scroll-suppression";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatBytes } from "@/lib/diff-thresholds";
import { Button } from "@/components/ui/button";
import {
  useFullContentRequestsStore,
  useRequestedPreview,
} from "@/stores/full-content-requests-store";

/** `preview` is the bounded wire copy; `full` the explicitly loaded payload. */
export type FullContentMode = "preview" | "full";

interface FullContentPreviewProps {
  preview: string;
  messageId?: number;
  /** Size of the complete content, when the server reported it. */
  fullBytes?: number;
  /** Drop the "Truncated · Show all" line, e.g. under a folded card. */
  hideLine?: boolean;
  children: (content: string, mode: FullContentMode) => ReactNode;
}

/**
 * How long a requested payload outlives its last mounted row. Virtuoso remounts
 * every row when a load makes one much taller, and rows scroll away and back;
 * neither may download the payload again. Finite so a request nothing releases
 * (its conversation closed, a revision un-truncated it) cannot pin it forever.
 */
const FULL_CONTENT_GC_MS = 5 * 60_000;

/**
 * Explicit request/release of one message's full content. Each "Show all"
 * fetches afresh, so a later revision never shows a stale payload; "Show less"
 * frees it at once.
 */
function useFullContentRequest(messageId: number | undefined) {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const drop = (id: number): void =>
      queryClient.removeQueries({ queryKey: getGetMessageFullContentQueryKey(id) });
    return {
      request: (preview: string): void => {
        if (messageId === undefined) return;
        suppressAutoScrollPin();
        drop(messageId);
        useFullContentRequestsStore.getState().request(messageId, preview);
      },
      release: (): void => {
        if (messageId === undefined) return;
        suppressAutoScrollPin();
        useFullContentRequestsStore.getState().release(messageId);
        drop(messageId);
      },
    };
  }, [queryClient, messageId]);
}

/**
 * A truncated block renders its preview through the block's own renderer,
 * dissolving past a fixed height, with one quiet line to load the rest. The
 * complete payload is fetched only on that explicit action and released on
 * "Show less".
 */
export function FullContentPreview({
  preview,
  messageId,
  fullBytes,
  hideLine = false,
  children,
}: FullContentPreviewProps): ReactElement {
  const requestedPreview = useRequestedPreview(messageId);
  const { request, release } = useFullContentRequest(messageId);
  // A revision replaced the preview the request was made against: that payload
  // is another message's now, so let it go instead of holding it unreachable.
  const outdated = requestedPreview !== undefined && requestedPreview !== preview;
  useEffect(() => {
    if (outdated) release();
  }, [outdated, release]);
  if (requestedPreview === preview && messageId !== undefined) {
    return (
      <RequestedFullContent
        preview={preview}
        messageId={messageId}
        fullBytes={fullBytes}
        release={release}
        children={children}
      />
    );
  }
  return (
    <PreviewContent
      preview={preview}
      fullBytes={fullBytes}
      status={messageId === undefined ? "unavailable" : "preview"}
      hideLine={hideLine}
      load={() => request(preview)}
      children={children}
    />
  );
}

function RequestedFullContent({
  preview,
  messageId,
  fullBytes,
  release,
  children,
}: Required<Pick<FullContentPreviewProps, "messageId">> &
  Omit<FullContentPreviewProps, "messageId" | "hideLine"> & { release: () => void }): ReactElement {
  const query = useGetMessageFullContent(messageId, {
    query: {
      gcTime: FULL_CONTENT_GC_MS,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      // A failure waits for the explicit Retry, not for the next remount.
      retryOnMount: false,
    },
  });
  // The response lands after the click's suppression window; keep this
  // user-requested height change from scrolling the row out of view.
  useLayoutEffect(() => {
    suppressAutoScrollPin();
  }, [query.data, query.isError]);
  if (query.data) {
    return (
      <div>
        {children(query.data.content, "full")}
        <TruncationLine label={sizeLabel("Full content", fullBytes)}>
          <LineAction onClick={release} expanded>
            Show less
          </LineAction>
        </TruncationLine>
      </div>
    );
  }
  return (
    <PreviewContent
      preview={preview}
      fullBytes={fullBytes}
      status={query.isError ? "error" : "loading"}
      error={
        query.isError ? apiErrorMessage(query.error, "Could not load full content") : undefined
      }
      load={() => void query.refetch()}
      cancel={release}
      children={children}
    />
  );
}

interface PreviewContentProps {
  preview: string;
  fullBytes?: number;
  status: "preview" | "loading" | "error" | "unavailable";
  error?: string;
  hideLine?: boolean;
  load: () => void;
  /** Back to the preview while loading or after a failure. */
  cancel?: () => void;
  children: FullContentPreviewProps["children"];
}

/**
 * The mask shows the first 20rem whole, fades the next 4rem out and hides the
 * rest; the max height then reclaims the hidden part. Shorter content sits
 * entirely in the solid layer, so a collapsed card never fades. A mask rather
 * than a `--background` scrim, which leaves a seam on translucent themes.
 */
const PREVIEW_CLIP =
  "max-h-96 overflow-hidden [mask-image:linear-gradient(#000,#000),linear-gradient(#000,transparent)] [mask-position:0_0,0_20rem] [mask-repeat:no-repeat] [mask-size:100%_20rem,100%_4rem]";

function PreviewContent({
  preview,
  fullBytes,
  status,
  error,
  hideLine = false,
  load,
  cancel,
  children,
}: PreviewContentProps): ReactElement {
  return (
    <div>
      <div className={PREVIEW_CLIP}>{children(preview, "preview")}</div>
      {!hideLine && (
        <TruncationLine label={sizeLabel("Truncated", fullBytes)}>
          {status === "unavailable" ? (
            <span>full content unavailable for this unsaved message</span>
          ) : (
            <LineAction onClick={load} disabled={status === "loading"}>
              {status === "loading" && <Loader2Icon className="size-3 animate-spin" />}
              {status === "loading" ? "Loading…" : status === "error" ? "Retry" : "Show all"}
            </LineAction>
          )}
          {cancel && (
            <>
              <span aria-hidden>·</span>
              <LineAction onClick={cancel}>Cancel</LineAction>
            </>
          )}
        </TruncationLine>
      )}
      {error && (
        <p role="alert" className="mt-0.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function sizeLabel(prefix: string, fullBytes: number | undefined): string {
  return fullBytes === undefined ? prefix : `${prefix} · ${formatBytes(fullBytes)}`;
}

function TruncationLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      <span aria-hidden>·</span>
      {children}
    </div>
  );
}

function LineAction({
  onClick,
  disabled,
  expanded = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto gap-1 p-0 text-xs font-medium"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
    >
      {children}
    </Button>
  );
}
