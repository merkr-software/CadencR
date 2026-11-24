import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useRef, type ReactElement } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { preloadableChunk } from "@/components/lazy/lazy-chunk";

// Its own chunk (file icons, previews): under a mouse it is fetched once idle
// after the first paint (`useKeyboardSurfacePrefetch`), under a finger when
// it first opens.
const paletteSurfaceChunk = preloadableChunk(() =>
  import("@/components/command-palette/PaletteSurface").then((module) => module.PaletteSurface),
);
const PaletteSurface = paletteSurfaceChunk.Component;
export const preloadCommandPalette = paletteSurfaceChunk.preload;
export const prefetchCommandPalette = paletteSurfaceChunk.prefetch;

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeProjectId: number | null;
  activeFeatureId: number | null;
}

/**
 * ⌘K: one place to go anywhere and find anything — conversations (archives
 * included), projects, commands, settings, files of the open worktree and
 * words said in any conversation.
 *
 * The surface mounts only while open, so every query runs on opening and
 * nothing listens while it is closed. Closing hands focus back to whatever
 * had it (the composer, a terminal) unless a picked action takes it: that
 * action runs only after the dialog is gone, so a dialog it opens or a tab it
 * focuses keeps the focus.
 */
export function CommandPalette({
  open,
  onOpenChange,
  activeProjectId,
  activeFeatureId,
}: CommandPaletteProps): ReactElement {
  const { t } = useUiTranslation();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const backRef = useRef<(() => boolean) | null>(null);

  const finish = useCallback(
    (action?: () => void) => {
      pendingActionRef.current = action ?? null;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="cp-dialog"
        showCloseButton={false}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          returnFocusRef.current =
            active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusRef.current;
          returnFocusRef.current = null;
          if (target?.isConnected) target.focus({ preventScroll: true });
          const action = pendingActionRef.current;
          pendingActionRef.current = null;
          action?.();
        }}
        onEscapeKeyDown={(event) => {
          if (backRef.current?.()) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{t("palette.title", "Command palette")}</DialogTitle>
        <LazyBoundary label="command palette" variant="inline">
          <PaletteSurface
            activeProjectId={activeProjectId}
            activeFeatureId={activeFeatureId}
            finish={finish}
            backRef={backRef}
          />
        </LazyBoundary>
      </DialogContent>
    </Dialog>
  );
}
