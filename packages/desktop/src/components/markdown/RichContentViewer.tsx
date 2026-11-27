import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { CopyIcon, RotateCcwIcon } from "lucide-react";
import { OpenDiffInEditorProvider } from "@/components/diff/OpenDiffInEditorContext";
import { FullscreenDialog } from "@/components/FullscreenDialog";
import { LinkRoutingContext } from "@/components/links/LinkRoutingContext";
import { PHONE_VIEWER_BUTTON, PhoneViewerHeader } from "@/components/PhoneViewerHeader";
import { Button } from "@/components/ui/button";
import { useAnchoredZoom } from "@/hooks/useAnchoredZoom";
import { useTouchPinch } from "@/hooks/useTouchPinch";
import { copyToClipboard } from "@/lib/clipboard";
import { useUiTranslation } from "@/lib/i18n/ui";
import { tableToMarkdown } from "@/lib/table-to-markdown";
import {
  useRichViewerStore,
  type RichViewerContent,
  type RichViewerLinks,
} from "@/stores/rich-viewer-store";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

/** The block's link actions around its content, as in the message it came from. */
function WithMessageLinks({
  links,
  children,
}: {
  links: RichViewerLinks;
  children: ReactNode;
}): ReactElement {
  const routed = (
    <LinkRoutingContext.Provider value={links.routing}>{children}</LinkRoutingContext.Provider>
  );
  return links.openInEditor ? (
    <OpenDiffInEditorProvider onOpenFileInEditor={links.openInEditor}>
      {routed}
    </OpenDiffInEditorProvider>
  ) : (
    routed
  );
}

/**
 * A rich block full screen: a 44px header (title, Copy, Close) over the
 * content, which pans both ways with a finger and zooms with a pinch (CSS
 * `zoom`, so the scrolled area grows with it). Copy writes a code block's
 * source, or the table on screen as Markdown.
 */
function RichViewerBody({
  viewer,
  links,
  onClose,
}: {
  viewer: RichViewerContent;
  links: RichViewerLinks;
  onClose: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const setViewportRef = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewport(element);
  }, []);
  const { scale, setScale, zoomAt } = useAnchoredZoom(viewportRef, MIN_ZOOM, MAX_ZOOM);
  useTouchPinch(viewport, zoomAt);
  const copy = (): void => {
    const table = viewportRef.current?.querySelector("table");
    const text = viewer.kind === "code" ? viewer.code : table ? tableToMarkdown(table) : "";
    void copyToClipboard(text, t("common.copied", "Copied"));
  };
  return (
    <>
      <PhoneViewerHeader title={viewer.title} onClose={onClose}>
        {scale !== 1 && (
          <Button
            variant="ghost"
            className={PHONE_VIEWER_BUTTON}
            aria-label={t("workspace.tools.browserToolbarActions.resetZoom", "Reset zoom")}
            onClick={() => setScale(1)}
          >
            <RotateCcwIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          className={PHONE_VIEWER_BUTTON}
          aria-label={
            viewer.kind === "table"
              ? t("markdown.richViewer.copyTable", "Copy table")
              : t("markdown.richViewer.copyCode", "Copy {{language}}", {
                  language: viewer.title.toLowerCase(),
                })
          }
          onClick={copy}
        >
          <CopyIcon />
        </Button>
      </PhoneViewerHeader>
      <div
        ref={setViewportRef}
        data-rich-viewer
        className="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain"
      >
        <div className="inline-block min-w-full p-4 align-top" style={{ zoom: scale }}>
          <WithMessageLinks links={links}>{viewer.content}</WithMessageLinks>
        </div>
      </div>
    </>
  );
}

/**
 * The app's single full-screen table or code block (the phone layout's
 * Expand, `RichBlocks.tsx`), mounted once beside the other root overlays so
 * a transcript row that remounts never closes it. Nothing is mounted while
 * it is closed.
 */
export function RichContentViewerHost(): ReactElement {
  const open = useRichViewerStore((s) => s.open);
  const close = useRichViewerStore((s) => s.close);
  return (
    <FullscreenDialog open={open !== null} onClose={close} title={open?.viewer.title ?? ""}>
      {open && <CloseOnNavigation onClose={close} />}
      {open && <RichViewerBody viewer={open.viewer} links={open.links} onClose={close} />}
    </FullscreenDialog>
  );
}

/**
 * A link inside the viewer (or a back gesture, a deep link) navigates: the
 * viewer belongs to the page it was opened on, so it closes with it. Mounted
 * only while the viewer is open.
 */
function CloseOnNavigation({ onClose }: { onClose: () => void }): null {
  const href = useRouterState({ select: (state) => state.location.href });
  const openedOn = useRef(href);
  useEffect(() => {
    if (href !== openedOn.current) onClose();
  }, [href, onClose]);
  return null;
}
