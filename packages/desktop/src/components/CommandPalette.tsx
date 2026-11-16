import { useCallback, useRef, type ReactElement } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PaletteSurface } from "@/components/command-palette/PaletteSurface";

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
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <PaletteSurface
          activeProjectId={activeProjectId}
          activeFeatureId={activeFeatureId}
          finish={finish}
          backRef={backRef}
        />
      </DialogContent>
    </Dialog>
  );
}
