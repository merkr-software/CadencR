import { memo, useCallback, useRef, type ReactElement } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import type { BrowserDownload } from "@/lib/desktop-bridge";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { cn } from "@/lib/utils";
import { useBrowserDownloads, type BrowserDownloadsController } from "./useBrowserDownloads";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

interface BrowserDownloadsPanelProps {
  scopeId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const BrowserDownloadsPanel = memo(function BrowserDownloadsPanel({
  scopeId,
  open,
  onOpenChange,
}: BrowserDownloadsPanelProps): ReactElement {
  const controller = useBrowserDownloads(scopeId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Radix returns focus to the trigger on close, which an invisible (folded)
  // trigger cannot take; hand it to the overflow menu button standing in for
  // it rather than letting it drop to the body.
  const returnFocusFromFoldedTrigger = useCallback((event: Event): void => {
    const trigger = triggerRef.current;
    if (!trigger || getComputedStyle(trigger).visibility !== "hidden") return;
    const overflow = trigger
      .closest("form")
      ?.querySelector<HTMLElement>("[data-browser-overflow-trigger]");
    if (!overflow) return;
    event.preventDefault();
    overflow.focus();
  }, []);
  const shortcut = useShortcutLabel("browser-downloads");
  const { activeCount = 0, aggregatePercent = null } = controller.snapshot ?? {};
  const summary =
    activeCount > 0
      ? `${activeCount} active${aggregatePercent === null ? "" : `, ${aggregatePercent}%`}`
      : "No active downloads";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          // While idle it folds into the toolbar's overflow menu on narrow
          // widths, but stays laid out (invisible, out of the flow) as the
          // popover's anchor. A running download keeps it, and its count, shown.
          className={cn(
            "relative shrink-0",
            activeCount === 0 &&
              "@max-[50rem]:invisible @max-[50rem]:absolute @max-[50rem]:right-0",
          )}
          aria-label={`Downloads: ${summary}`}
          title={`${summary} (${shortcut})`}
        >
          <DownloadIcon className="size-4" />
          {activeCount > 0 ? (
            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-4 text-primary-foreground">
              {activeCount > 9 ? "9+" : activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
        onCloseAutoFocus={returnFocusFromFoldedTrigger}
      >
        <DownloadsHeader controller={controller} />
        <DownloadsBody controller={controller} />
      </PopoverContent>
    </Popover>
  );
});

function DownloadsHeader({ controller }: { controller: BrowserDownloadsController }): ReactElement {
  const finished = controller.snapshot?.downloads.some((download) => !download.canCancel) ?? false;
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Downloads</p>
        <p className="text-xs text-muted-foreground">Saved to your Downloads folder</p>
      </div>
      {finished ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={controller.pending !== null}
          aria-busy={controller.pending === "clear:all"}
          onClick={() => void controller.clear()}
        >
          {controller.pending === "clear:all" ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <Trash2Icon />
          )}
          Clear finished
        </Button>
      ) : null}
    </div>
  );
}

function DownloadsBody({ controller }: { controller: BrowserDownloadsController }): ReactElement {
  const downloads = controller.snapshot?.downloads ?? [];
  const hasPrivate = downloads.some((download) => download.private);
  return (
    <>
      {controller.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1">{controller.error}</span>
          {!controller.loading ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={controller.pending !== null}
              onClick={() => void controller.reload()}
            >
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss download error"
            onClick={controller.dismissError}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {hasPrivate ? (
        <div className="flex gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          Private browsing history is not saved, but downloaded files remain on disk.
        </div>
      ) : null}
      {controller.loading ? (
        <PanelMessage icon={<Loader2Icon className="animate-spin" />} text="Loading downloads…" />
      ) : downloads.length === 0 ? (
        <PanelMessage icon={<DownloadIcon />} text="No downloads yet" />
      ) : (
        <DownloadsList downloads={downloads} controller={controller} />
      )}
    </>
  );
}

function DownloadsList({
  downloads,
  controller,
}: {
  downloads: BrowserDownload[];
  controller: BrowserDownloadsController;
}): ReactElement {
  const itemContent = useCallback(
    (_index: number, download: BrowserDownload) => (
      <DownloadRow
        download={download}
        busy={controller.pending !== null}
        pending={controller.pending?.endsWith(`:${download.id}`) ?? false}
        pause={controller.pause}
        resume={controller.resume}
        cancel={controller.cancel}
        reveal={controller.reveal}
      />
    ),
    [controller.cancel, controller.pause, controller.pending, controller.resume, controller.reveal],
  );
  const height = Math.min(320, Math.max(76, downloads.length * 84));
  return <Virtuoso style={{ height }} data={downloads} itemContent={itemContent} />;
}

const DownloadRow = memo(function DownloadRow({
  download,
  busy,
  pending,
  pause,
  resume,
  cancel,
  reveal,
}: {
  download: BrowserDownload;
  busy: boolean;
  pending: boolean;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  reveal: (id: string) => Promise<void>;
}): ReactElement {
  return (
    <div className="flex gap-2 px-3 py-2.5">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <DownloadIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={download.filename}>
          {download.filename}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {downloadStatus(download)} · {formatBytes(download.receivedBytes)}
          {download.totalBytes === null ? "" : ` of ${formatBytes(download.totalBytes)}`}
        </p>
        <p className="truncate text-[10px] text-muted-foreground" title={download.destination}>
          {download.destination}
        </p>
        {download.canCancel ? <DownloadProgress download={download} /> : null}
        {download.error ? (
          <p className="mt-0.5 text-[11px] text-destructive">{download.error}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {pending ? (
          <Loader2Icon className="mx-1 size-3.5 animate-spin text-muted-foreground" />
        ) : null}
        {!pending && download.canPause ? (
          <IconAction
            disabled={busy}
            label="Pause download"
            icon={<PauseIcon />}
            onClick={() => void pause(download.id)}
          />
        ) : null}
        {!pending && download.canResume ? (
          <IconAction
            disabled={busy}
            label="Resume download"
            icon={<PlayIcon />}
            onClick={() => void resume(download.id)}
          />
        ) : null}
        {!pending && download.canCancel ? (
          <IconAction
            disabled={busy}
            label="Cancel download"
            icon={<XIcon />}
            onClick={() => void cancel(download.id)}
          />
        ) : null}
        {!pending && download.state === "completed" ? (
          <IconAction
            disabled={busy}
            label={PLATFORM_IS_MAC ? "Show in Finder" : "Show in folder"}
            icon={<FolderOpenIcon />}
            onClick={() => void reveal(download.id)}
          />
        ) : null}
      </div>
    </div>
  );
});

function DownloadProgress({ download }: { download: BrowserDownload }): ReactElement {
  return (
    <Progress
      className="mt-1"
      value={download.percent}
      aria-label={`${download.filename} download progress`}
    />
  );
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactElement;
  onClick: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
}

function PanelMessage({ icon, text }: { icon: ReactElement; text: string }): ReactElement {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-muted-foreground">
      {icon}
      {text}
    </div>
  );
}

function downloadStatus(download: BrowserDownload): string {
  return download.state[0].toUpperCase() + download.state.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}
