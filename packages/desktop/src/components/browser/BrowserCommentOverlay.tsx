import { useUiTranslation } from "@/lib/i18n/ui";
import * as React from "react";
import { ImageIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CommentForm } from "@/components/diff/DiffCommentWidget";
import { cn } from "@/lib/utils";
import type { BrowserResponsiveGeometry } from "@/shared/browser-responsive";

import { describeElement } from "./format-context";
import type { BrowserCommentDraft } from "./useBrowserComments";
import { transformBrowserPageBounds } from "./BrowserResponsiveViewport";

const PAD = 8;
const WIDTH = 360;

export interface BrowserCommentOverlayProps {
  draft: BrowserCommentDraft;
  /** The viewport container the form is positioned within (the page region). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  pageGeometry?: BrowserResponsiveGeometry | null;
  onSave: (text: string) => void;
  onCancel: () => void;
  onToggleScreenshot: () => void;
  /** Delete the comment being edited (only shown when editing a saved one). */
  onRemove: (id: string) => void;
}

interface Placement {
  left: number;
  top: number;
  width: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, Math.max(min, max)));

/** Place the form under the anchored element, flipping above when it overflows. */
function place(box: BrowserCommentDraft["box"], container: DOMRect, formHeight: number): Placement {
  const width = Math.min(WIDTH, container.width - PAD * 2);
  if (!box) {
    return { left: (container.width - width) / 2, top: PAD, width };
  }
  const left = clamp(box.x, PAD, container.width - width - PAD);
  const below = box.y + box.height + 6;
  if (below + formHeight <= container.height - PAD) return { left, top: below, width };
  const above = box.y - formHeight - 6;
  return {
    left,
    top: above >= PAD ? above : clamp(below, PAD, container.height - formHeight - PAD),
    width,
  };
}

/**
 * The comment composer, floated under the picked element over the frozen page
 * snapshot. Re-measures placement whenever the draft (or its anchor box)
 * changes, and after the form lays out, so it never spills past the viewport.
 */
function BrowserCommentOverlayImpl(props: BrowserCommentOverlayProps): React.JSX.Element {
  const { t } = useUiTranslation();
  const { draft, containerRef, onSave, onCancel, onToggleScreenshot, onRemove, pageGeometry } =
    props;
  const formRef = React.useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = React.useState<Placement | null>(null);

  React.useLayoutEffect(() => {
    const container = containerRef.current?.getBoundingClientRect();
    if (!container) return;
    const formHeight = formRef.current?.offsetHeight ?? 180;
    setPlacement(
      place(transformBrowserPageBounds(draft.box, pageGeometry ?? null), container, formHeight),
    );
  }, [containerRef, draft.box, draft.id, pageGeometry]);

  return (
    <div
      ref={formRef}
      className="absolute z-20 overflow-hidden rounded-lg border bg-popover shadow-lg"
      style={{
        left: placement?.left ?? PAD,
        top: placement?.top ?? PAD,
        width: placement?.width ?? WIDTH,
        // Hide the first pre-measurement frame so the form doesn't flash at the
        // wrong spot before useLayoutEffect places it.
        visibility: placement ? "visible" : "hidden",
      }}
    >
      <div className="flex items-center gap-2 px-2 pt-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--acc-purple)] text-[11px] font-semibold text-white">
          {draft.number}
        </span>
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {describeElement(draft.context)}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={
            draft.includeScreenshot
              ? t("workspace.tools.browserCommentOverlay.screenshotAttached", "Screenshot attached")
              : t("workspace.tools.browserCommentOverlay.attachScreenshot", "Attach screenshot")
          }
          aria-pressed={draft.includeScreenshot}
          className={cn(draft.includeScreenshot ? "text-primary" : "text-muted-foreground")}
          onClick={onToggleScreenshot}
        >
          <ImageIcon className="size-3.5" />
        </Button>
        {draft.editing ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("workspace.tools.browserCommentOverlay.removeComment", "Remove comment")}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(draft.id)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <CommentForm
        initialContent={draft.initialText}
        submitLabel={
          draft.editing
            ? t("workspace.tools.browserCommentOverlay.update", "Update")
            : t("workspace.tools.browserCommentOverlay.comment", "Comment")
        }
        onSubmit={onSave}
        onClose={onCancel}
      />
    </div>
  );
}

export const BrowserCommentOverlay = React.memo(BrowserCommentOverlayImpl);
