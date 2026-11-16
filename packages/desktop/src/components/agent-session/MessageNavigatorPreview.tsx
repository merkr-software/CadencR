import { format, isThisYear, isToday } from "date-fns";
import { ImageIcon, Loader2Icon, MessageSquareTextIcon, PaperclipIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { UserMessageMark } from "@/lib/agent-message-navigator";
import { ResolvedShortcutHint } from "@/components/KbdShortcut";
import { Badge } from "@/components/ui/badge";
import { parseUTCDateTime } from "@/lib/date-utils";

export interface RailBox {
  /** Rail box in viewport coordinates. */
  rect: DOMRect;
  /** Top edge of the stream the rail sits in, in viewport coordinates. */
  ceiling: number;
}

interface MessageNavigatorPreviewProps {
  mark: UserMessageMark;
  index: number;
  count: number;
  /** Tick position along the rail, 0–1. */
  fraction: number;
  rail: RailBox;
  /** The prompt's turn is loading so it can be reached. */
  loading: boolean;
}

/** Gap between the rail and the card. */
const PREVIEW_GAP_PX = 10;
/** Space kept between the card and the top of the stream. */
const PREVIEW_CEILING_GAP_PX = 8;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "14:32" today, "Sep 20, 23:13" this year, "Sep 20, 2025" before. */
function formatSentAt(iso: string): string {
  const date = parseUTCDateTime(iso);
  if (isToday(date)) return format(date, "HH:mm");
  return format(date, isThisYear(date) ? "MMM d, HH:mm" : "MMM d, yyyy");
}

function Extra({ icon, children }: { icon: ReactNode; children: ReactNode }): ReactElement {
  return (
    <Badge
      variant="outline"
      className="bg-muted/60 text-[10.5px] font-normal text-muted-foreground"
    >
      {icon}
      {children}
    </Badge>
  );
}

function PreviewFooter({ loading }: { loading: boolean }): ReactElement {
  if (loading) {
    return (
      <div
        role="status"
        className="flex items-center gap-1.5 border-t border-border/60 bg-muted/40 px-3 py-1.5 text-[10.5px] text-muted-foreground"
      >
        <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" aria-hidden />
        <span className="text-foreground/80">Loading this message…</span>
        <span className="ml-auto">Click again to cancel</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 border-t border-border/60 bg-muted/40 px-3 py-1.5 text-[10.5px] text-muted-foreground">
      <span>Click to jump</span>
      <span className="ml-auto inline-flex items-center gap-1">
        <ResolvedShortcutHint shortcutId="agent-previous-message" />
        <ResolvedShortcutHint shortcutId="agent-next-message" />
      </span>
    </div>
  );
}

function PreviewBody({ mark }: { mark: UserMessageMark }): ReactElement {
  const hasExtras = mark.imageCount > 0 || mark.attachmentCount > 0;
  return (
    <div className="px-3 pb-3">
      {mark.text ? (
        <p className="line-clamp-6 border-l-2 border-primary/60 pl-2.5 text-[13px] leading-relaxed break-words text-foreground">
          {mark.text}
        </p>
      ) : (
        <p className="border-l-2 border-border pl-2.5 text-xs text-muted-foreground italic">
          No text
        </p>
      )}
      {hasExtras && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {mark.imageCount > 0 && (
            <Extra icon={<ImageIcon aria-hidden />}>{plural(mark.imageCount, "image")}</Extra>
          )}
          {mark.attachmentCount > 0 && (
            <Extra icon={<PaperclipIcon aria-hidden />}>
              {plural(mark.attachmentCount, "file")}
            </Extra>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Card top for a card of `height`: hung off the tick (at viewport y `anchor`)
 * by the tick's own fraction along the rail, then kept between the stream's top and the rail's
 * bottom — below it lies the composer, which the card must not cover.
 */
function previewTop(rail: RailBox, anchor: number, fraction: number, height: number): number {
  const lowest = rail.rect.bottom - height;
  const highest = rail.ceiling + PREVIEW_CEILING_GAP_PX;
  return Math.max(highest, Math.min(anchor - fraction * height, lowest));
}

/**
 * Hover card beside the rail showing the prompt under the pointer.
 *
 * Anchored on the tick, then shifted up by the same fraction it sits at along
 * the rail: a top tick's card hangs down, a bottom tick's card rises, a middle
 * one centres. A card taller than the rail is pushed up so it never reaches
 * the composer below. It grows out of the tick, so it reads as unfolding
 * from it.
 *
 * Portaled to the body: the agent pane is frosted, and a backdrop-filter
 * ancestor is a backdrop root that leaves an in-tree card unblurred, the
 * transcript showing straight through it.
 */
export function MessageNavigatorPreview({
  mark,
  index,
  count,
  fraction,
  rail,
  loading,
}: MessageNavigatorPreviewProps): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  // Re-measured after every render (the hovered prompt or the loading row
  // changes it); the extra render lands before paint, so no frame is misplaced.
  useLayoutEffect(() => {
    const measured = cardRef.current?.offsetHeight ?? 0;
    if (measured !== height) setHeight(measured);
  });
  const anchor = rail.rect.top + fraction * rail.rect.height;
  const top = previewTop(rail, anchor, fraction, height);

  return createPortal(
    <div
      role="tooltip"
      data-testid="message-navigator-preview"
      style={{ left: rail.rect.left - PREVIEW_GAP_PX, top, transform: "translateX(-100%)" }}
      className="pointer-events-none fixed z-50 w-80 max-w-[70vw]"
    >
      {/* The hover-card slot opts into the frost themes' overlay glass. */}
      <div
        ref={cardRef}
        data-slot="hover-card-content"
        style={{ transformOrigin: `right ${anchor - top}px` }}
        className="overflow-hidden rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95 slide-in-from-right-1 duration-150 ease-out"
      >
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-2 text-[11px]">
          <MessageSquareTextIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="font-medium text-foreground/90">Your message</span>
          <span className="font-mono text-muted-foreground tabular-nums">
            {index + 1}/{count}
          </span>
          {mark.createdAt && (
            <span className="ml-auto font-mono text-muted-foreground tabular-nums">
              {formatSentAt(mark.createdAt)}
            </span>
          )}
        </div>
        <PreviewBody mark={mark} />
        <PreviewFooter loading={loading} />
      </div>
    </div>,
    document.body,
  );
}
