import { useState, type ReactElement, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSuppressBrowserView } from "@/lib/browser-suppression";
import { cn } from "@/lib/utils";

/**
 * A page in the phone layout: the app viewport's height (it shrinks with the
 * on-screen keyboard), clear of the notch (on top, or on a side in landscape)
 * and of the home indicator (none above the keyboard).
 */
const PHONE_PAGE_INSETS = cn(
  "h-(--app-vh,100dvh) pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)]",
  "pb-(--app-inset-bottom) pl-[env(safe-area-inset-left)]",
);

/**
 * A large dialog (settings, an editor) as a page in the phone layout: the
 * whole app viewport (`PHONE_PAGE_INSETS`), its header left-aligned clear of
 * the close button, which sits below the notch with a 44px target (not
 * `hit-area`: its `position: relative` would undo the button's `absolute`).
 * Pass it to `DialogContent` in place of the desktop size when `useIsMobile()`
 * holds. `phone-page-dialog` marks it for the status-bar tint
 * (`mobile-status-bar.css`).
 */
export const PHONE_PAGE_DIALOG_CLASS = cn(
  "phone-page-dialog inset-0 top-0 left-0 bottom-auto translate-x-0 translate-y-0",
  "max-h-none w-full max-w-none sm:max-w-none rounded-none border-0",
  PHONE_PAGE_INSETS,
  "data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100",
  "[&>[data-slot=dialog-header]]:px-4 [&>[data-slot=dialog-header]]:pr-14 [&>[data-slot=dialog-header]]:text-left",
  "[&>[data-slot=dialog-close]]:top-[calc(env(safe-area-inset-top)+0.5rem)] [&>[data-slot=dialog-close]]:right-[calc(env(safe-area-inset-right)+0.5rem)]",
  "[&>[data-slot=dialog-close]]:flex [&>[data-slot=dialog-close]]:size-11 [&>[data-slot=dialog-close]]:items-center [&>[data-slot=dialog-close]]:justify-center",
);

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
  const phone = useIsMobile();
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
          phone && cn("bottom-auto", PHONE_PAGE_INSETS),
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
