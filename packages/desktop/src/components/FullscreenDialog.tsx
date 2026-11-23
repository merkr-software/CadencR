import type { ReactElement, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { useSuppressBrowserView } from "@/lib/browser-suppression";

interface FullscreenDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * Shared opaque full-window Radix dialog shell for rendered-content viewers
 * (`MermaidFullscreenHost`, `VisualFullscreenHost`). Escape closes it and
 * never leaks to the agent's "stop" shortcut while open.
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
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 flex flex-col bg-[oklch(from_var(--background)_l_c_h/1)] outline-none duration-150"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
