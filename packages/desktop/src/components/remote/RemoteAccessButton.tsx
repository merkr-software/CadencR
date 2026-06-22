import { lazy, Suspense, useEffect, type ReactElement } from "react";
import { Loader2, Radio } from "lucide-react";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { useRemoteStore } from "@/stores/remote-store";
import { useRemoteDialogStore } from "@/stores/remote-dialog-store";
import { cn } from "@/lib/utils";

// The dialog (and its QR dependency) only loads when the user opens the panel.
const RemoteAccessDialog = lazy(() =>
  import("./RemoteAccessDialog").then((m) => ({ default: m.RemoteAccessDialog })),
);

// While remote access is on, re-poll the loopback status so the connected-device
// count stays live (there's no push channel for remote connect/disconnect).
const CONNECTED_POLL_MS = 10_000;

/**
 * Compact remote-access control in the sidebar footer, sitting inline before the
 * version on the Settings row. The icon turns green when remote access is on and
 * shows the number of devices currently connected to this instance. Managing
 * remote access is host-only, so it's hidden inside a remote browser session.
 */
export function RemoteAccessButton(): ReactElement | null {
  const enabled = useRemoteStore((s) => s.status?.enabled ?? false);
  const connected = useRemoteStore((s) => s.status?.connected_devices ?? 0);
  const loaded = useRemoteStore((s) => s.loaded);
  const refresh = useRemoteStore((s) => s.refresh);
  // Dialog open state is lifted to a store so the "device connected" toast can
  // open it (and jump to the device list) from outside this component.
  const open = useRemoteDialogStore((s) => s.open);
  const setOpen = useRemoteDialogStore((s) => s.setOpen);

  // Fetch status once so the icon state is accurate before the dialog is opened.
  // Guarded to the host shell — the control endpoints are loopback-only.
  useEffect(() => {
    if (!isBrowserRemote() && !loaded) void refresh();
  }, [loaded, refresh]);

  // Keep the connected count fresh while remote access is enabled.
  useEffect(() => {
    if (isBrowserRemote() || !enabled) return;
    const id = setInterval(() => void refresh(), CONNECTED_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  if (isBrowserRemote()) return null;

  const title = enabled
    ? `Remote access ON — ${connected} device${connected === 1 ? "" : "s"} connected`
    : "Remote access";

  return (
    <>
      <button
        type="button"
        data-nav-item
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border border-transparent px-2 py-0.5",
          "text-[10px] text-muted-foreground transition-colors tabular-nums",
          "hover:border-border hover:bg-accent hover:text-foreground",
          "focus-visible:border-border focus-visible:bg-accent focus-visible:outline-none",
        )}
      >
        <Radio
          className={cn("size-3.5 shrink-0", enabled && "text-[var(--acc-green)]")}
          aria-hidden
        />
        {enabled ? <span>{connected}</span> : null}
      </button>

      {open ? (
        <Suspense
          fallback={
            // Brief dialog-chunk load: a dimmed backdrop + spinner so the open
            // click has immediate, modal-shaped feedback instead of a dead frame.
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
              <Loader2 className="size-5 animate-spin text-white" aria-hidden />
            </div>
          }
        >
          <RemoteAccessDialog onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
