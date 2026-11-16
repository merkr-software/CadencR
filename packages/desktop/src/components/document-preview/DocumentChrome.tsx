/**
 * Shared chrome for the document renderers: the centered loading / error
 * states, the bottom status bar (same anatomy as `ImageFileViewer`'s) and
 * its zoom controls.
 */
import type { ReactElement, ReactNode } from "react";
import { Loader2Icon, MaximizeIcon, MinusIcon, MoveHorizontalIcon, PlusIcon } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DocumentLoading({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon className="size-6 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function DocumentError({ message }: { message: string }): ReactElement {
  return (
    <div
      role="alert"
      className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive"
    >
      {message}
    </div>
  );
}

export function DocumentStatusBar({
  status,
  children,
}: {
  status: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <span className="truncate">{status}</span>
      {children && <div className="flex items-center gap-1">{children}</div>}
    </div>
  );
}

export function DocumentToolButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <ShortcutTooltip label={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(active && "bg-accent text-accent-foreground")}
      >
        {children}
      </Button>
    </ShortcutTooltip>
  );
}

/** What the zoom controls drive: an ooxml viewer, or the PDF view's zoom state. */
export interface ZoomableViewer {
  zoomIn(): void;
  zoomOut(): void;
  fitWidth(): void;
  fitPage(): void;
}

export function DocumentZoomControls({
  viewer,
  scale,
  fit = "width",
  fitActive,
  children,
}: {
  viewer: ZoomableViewer | null;
  /** 1 = the document's real size. */
  scale: number | null;
  /** What the fit button restores: the page width (documents) or the whole page (slides). */
  fit?: "width" | "page";
  /** Whether the view is currently following the fit. */
  fitActive?: boolean;
  children?: ReactNode;
}): ReactElement | null {
  if (!viewer) return null;
  return (
    <>
      {children}
      <DocumentToolButton label="Zoom out" onClick={() => viewer.zoomOut()}>
        <MinusIcon />
      </DocumentToolButton>
      <span className="w-10 text-center tabular-nums">
        {scale === null ? "" : `${Math.round(scale * 100)}%`}
      </span>
      <DocumentToolButton label="Zoom in" onClick={() => viewer.zoomIn()}>
        <PlusIcon />
      </DocumentToolButton>
      {fit === "page" ? (
        <DocumentToolButton label="Fit slide" active={fitActive} onClick={() => viewer.fitPage()}>
          <MaximizeIcon />
        </DocumentToolButton>
      ) : (
        <DocumentToolButton label="Fit width" active={fitActive} onClick={() => viewer.fitWidth()}>
          <MoveHorizontalIcon />
        </DocumentToolButton>
      )}
    </>
  );
}

/** Message for a rejected parse/render promise, never empty. */
export function documentErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return `${fallback}: ${error.message}`;
  return fallback;
}
