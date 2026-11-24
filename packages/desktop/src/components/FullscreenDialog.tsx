import { useState, type ReactElement, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { useSuppressBrowserView } from "@/lib/browser-suppression";
import { cn } from "@/lib/utils";

interface FullscreenDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * Shared opaque full-window Radix dialog shell for rendered-content viewers
 * (`MermaidFullscreenHost`, `VisualFullscreenHost`, `RichContentViewerHost`).
 * Escape closes it and never leaks to the agent's "stop" shortcut while open.
 * Closing returns focus to what had it when it opened (the Expand button):
 * these hosts open from a store, with no Radix trigger to fall back to.
 *
 * Composes `DialogPortal`/`DialogOverlay` by hand rather than `DialogContent`
 * (which gets a glass panel in frost themes) and forces an opaque `--background`
 * so transparent themed content never shows the transcript behind it.
 */
export function FullscreenDialog({
  open,
  onClose,
  title,
  children,
}: FullscreenDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && <FullscreenDialogSurface title={title}>{children}</FullscreenDialogSurface>}
    </Dialog>
  );
}

function FullscreenDialogSurface({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  // A native browser view paints above the React DOM; hide it while open.
  useSuppressBrowserView();
  // Read once, as the surface mounts: still the control that opened it.
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const restoreFocus = (event: Event): void => {
    // Radix would focus its (absent) trigger, leaving focus on the body.
    event.preventDefault();
    if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
  };
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onCloseAutoFocus={restoreFocus}
        className={cn(
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 flex flex-col bg-[oklch(from_var(--background)_l_c_h/1)] outline-none duration-150",
          // Phone layout: the app viewport's height (it shrinks with the
          // on-screen keyboard) and clear of the notch and the home indicator.
          "phone:bottom-auto phone:h-[var(--app-vh,100dvh)] phone:pt-[env(safe-area-inset-top)] phone:pr-[env(safe-area-inset-right)] phone:pb-[env(safe-area-inset-bottom)] phone:pl-[env(safe-area-inset-left)]",
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
