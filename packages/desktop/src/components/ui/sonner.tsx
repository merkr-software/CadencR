import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useToastAnchorStore, type ToastAnchor } from "@/stores/toast-anchor-store";

// Toasts stack in the sidebar, above its footer (why: DESIGN.md "Toasts");
// without an expanded desktop sidebar they fall back to top-center.
const FALLBACK_WIDTH = 380;

function placement(anchor: ToastAnchor | null): Pick<ToasterProps, "position" | "offset"> {
  if (anchor === null) {
    // In an iOS standalone PWA the UI runs under the status bar
    // (black-translucent + viewport-fit=cover); the inset is 0 elsewhere.
    return { position: "top-center", offset: { top: "calc(env(safe-area-inset-top) + 16px)" } };
  }
  return { position: "bottom-left", offset: { bottom: anchor.bottom, left: anchor.left } };
}

const TOAST_ICONS: ToasterProps["icons"] = {
  success: <CircleCheck />,
  error: <CircleAlert />,
  warning: <TriangleAlert />,
  info: <Info />,
  loading: <LoaderCircle className="animate-spin" />,
  close: <X />,
};

/**
 * Themed Sonner wrapper. Every variant shares the `--popover` surface; the
 * variant is carried by a tinted icon well (and a tinted rim for errors and
 * warnings). All chrome lives in `toast.css`. Per-call styling overrides at
 * the call site are forbidden — extend the styles there instead.
 */
function Toaster(props: ToasterProps) {
  const anchor = useToastAnchorStore((s) => s.anchor);
  return (
    <Sonner
      {...placement(anchor)}
      closeButton
      gap={8}
      icons={TOAST_ICONS}
      // Below 600px Sonner spans the toasts full-width at the top, under the
      // same safe-area inset.
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 12px)" }}
      style={
        {
          "--width": `${anchor?.width ?? FALLBACK_WIDTH}px`,
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
