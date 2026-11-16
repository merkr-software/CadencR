import type { ReactElement } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { MermaidDiagramView } from "@/components/MermaidDiagramView";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { useSuppressBrowserView } from "@/lib/browser-suppression";
import { useMermaidFullscreenStore } from "@/stores/mermaid-fullscreen-store";

/**
 * The app's single full-screen diagram view, mounted once beside the other
 * root overlays. Escape closes it (Radix Dialog), and because the dialog holds
 * focus while open, Escape never reaches the agent's "stop" shortcut.
 *
 * Like `ImageLightboxHost`, it composes `DialogPortal`/`DialogOverlay` by hand:
 * `DialogContent`'s `data-slot="dialog-content"` gets a glass panel and a
 * `backdrop-filter` in the frost themes, wrong for a full-window surface.
 */
export function MermaidFullscreenHost(): ReactElement {
  const svg = useMermaidFullscreenStore((s) => s.svg);
  const close = useMermaidFullscreenStore((s) => s.close);
  return (
    <Dialog open={svg !== null} onOpenChange={(next) => !next && close()}>
      {svg !== null && <MermaidFullscreenContent svg={svg} onClose={close} />}
    </Dialog>
  );
}

function MermaidFullscreenContent({ svg, onClose }: { svg: string; onClose: () => void }) {
  // A native browser view paints above the React DOM; hide it while open.
  useSuppressBrowserView();
  return (
    <DialogPortal>
      <DialogOverlay />
      {/* Opaque even in the frost themes, whose translucent --background would
          show the inline copy of the diagram through this one. */}
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 flex flex-col bg-[oklch(from_var(--background)_l_c_h/1)] outline-none duration-150"
      >
        <DialogTitle className="sr-only">Diagram</DialogTitle>
        <MermaidDiagramView svg={svg} variant="fullscreen" onClose={onClose} />
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
