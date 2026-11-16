import { useEffect, useRef, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import type { RemoteStatus } from "@/api/generated";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useRemoteStore, type RemotePhase } from "@/stores/remote-store";
import { useRemoteDialogStore } from "@/stores/remote-dialog-store";
import { desktopBridge } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { canPreventHostSleep, useRemotePreventSleep } from "@/lib/remote/sleep-prevention";
import { RemoteDisclosure } from "./remote-ui";
import { RemoteLanSection } from "./RemoteLanSection";
import { RemotePairSection } from "./RemotePairSection";
import { RemoteTunnelSection } from "./RemoteTunnelSection";
import { RemoteDevicesSection } from "./RemoteDevicesSection";
import { RemoteActivitySection } from "./RemoteActivitySection";

/**
 * Host control surface for remote access. Opens from the sidebar button; on
 * open it fetches current status. The on/off toggle, pairing, device list, and
 * audit tail all live here. Loopback-only — never rendered in a remote browser.
 */
export function RemoteAccessDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const status = useRemoteStore((s) => s.status);
  const loaded = useRemoteStore((s) => s.loaded);
  const phase = useRemoteStore((s) => s.phase);
  const error = useRemoteStore((s) => s.error);
  const refresh = useRemoteStore((s) => s.refresh);
  const enable = useRemoteStore((s) => s.enable);
  const disable = useRemoteStore((s) => s.disable);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabled = status?.enabled ?? false;
  // First fetch still in flight: show a loader rather than a misleading "off".
  const initialLoading = !loaded && phase === "loading";

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remote access</DialogTitle>
          <DialogDescription>
            Use this workspace from another device over your network. Anyone who can reach your
            machine and pair gains full access — only enable it on networks you trust.
          </DialogDescription>
        </DialogHeader>

        {initialLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Checking remote access…
          </div>
        ) : (
          <>
            <RemoteToggleRow
              enabled={enabled}
              phase={phase}
              onEnable={() => void enable()}
              onDisable={() => void disable()}
            />

            {canPreventHostSleep(desktopBridge.isElectron, isBrowserRemote()) ? (
              <SleepPreventionToggle />
            ) : null}

            {error ? <p className="text-xs text-[var(--acc-red)]">{error}</p> : null}

            {enabled && status ? <RemoteEnabledSections status={status} /> : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The primary remote on/off switch, with an inline spinner while mutating. */
function RemoteToggleRow({
  enabled,
  phase,
  onEnable,
  onDisable,
}: {
  enabled: boolean;
  phase: RemotePhase;
  onEnable: () => void;
  onDisable: () => void;
}): ReactElement {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">Remote access is {enabled ? "on" : "off"}</div>
        <div className="text-xs text-muted-foreground">
          {enabled
            ? "Reachable over TLS on your local network."
            : "Turn on to expose the workspace over your local network."}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {phase === "mutating" ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
        <Switch
          checked={enabled}
          disabled={phase !== "idle"}
          onCheckedChange={(next) => (next ? onEnable() : onDisable())}
          aria-label="Toggle remote access"
        />
      </div>
    </div>
  );
}

/**
 * Keep the host awake while hosting. Shown only on the desktop host (a paired
 * browser has no blocker to hold), so remote users see no dead control. The preference
 * persists independently of the on/off state; the blocker is only held while
 * remote access is also active (see `useRemoteSleepGuard`).
 */
function SleepPreventionToggle(): ReactElement {
  const [preventSleep, setPreventSleep] = useRemotePreventSleep();
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">Prevent sleep while hosting</div>
        <div className="text-xs text-muted-foreground">
          Keeps this computer awake while remote access is active. The screen can still lock or turn
          off. Manual sleep, lid close, or low battery may still interrupt hosting.
        </div>
      </div>
      <Switch
        checked={preventSleep}
        onCheckedChange={setPreventSleep}
        aria-label="Prevent sleep while hosting"
      />
    </div>
  );
}

/**
 * The QR/pairing hero plus the collapsed reference/management disclosures. The
 * paired-devices section is controlled so the "View devices" toast action can
 * expand it and scroll it into view (each toast bumps `focusDevicesNonce`).
 */
function RemoteEnabledSections({ status }: { status: RemoteStatus }): ReactElement {
  const focusDevicesNonce = useRemoteDialogStore((s) => s.focusDevicesNonce);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const devicesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusDevicesNonce === 0) return;
    setDevicesOpen(true);
    // Wait a frame for the section to expand, then bring it into view.
    const raf = requestAnimationFrame(() => {
      devicesRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusDevicesNonce]);

  return (
    <div className="max-h-[calc(var(--app-vh)*0.6)] space-y-3 overflow-y-auto pr-1">
      {/* Hero: the primary task is pairing a device, so the QR leads. */}
      <RemotePairSection status={status} />

      {/* Everything else is reference or management — collapsed by default so
          the dialog stays a one-glance "it's on, scan this". */}
      <RemoteDisclosure title="Connection & certificate">
        <RemoteLanSection status={status} />
      </RemoteDisclosure>
      <RemoteDisclosure title="Expose over the internet">
        <RemoteTunnelSection status={status} />
      </RemoteDisclosure>
      <div ref={devicesRef}>
        <RemoteDisclosure
          title={`Paired devices (${status.devices.length})`}
          open={devicesOpen}
          onOpenChange={setDevicesOpen}
        >
          <RemoteDevicesSection status={status} />
        </RemoteDisclosure>
      </div>
      <RemoteDisclosure title="Recent activity">
        <RemoteActivitySection status={status} />
      </RemoteDisclosure>
    </div>
  );
}
