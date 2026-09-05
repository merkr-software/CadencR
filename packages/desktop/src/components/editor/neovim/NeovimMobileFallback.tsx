import { MonitorSmartphoneIcon } from "lucide-react";

/**
 * Shown instead of `NeovimPane` when `useIsMobile()` is true, even if the vim
 * mode level is set to full Neovim. No PTY session is started for this
 * client — `EditorPane` falls back to its normal CodeMirror content below
 * this banner, exactly as it would at level 0/1.
 */
export default function NeovimMobileFallback() {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <MonitorSmartphoneIcon className="size-3.5 shrink-0" />
      <span>Full Neovim is not available on mobile — showing the standard editor instead.</span>
    </div>
  );
}
