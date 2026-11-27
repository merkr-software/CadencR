import { useEffect, useId, useRef, type ReactElement } from "react";
import { Loader2, Smartphone } from "lucide-react";
import type { RemoteStatus } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useUiTranslation } from "@/lib/i18n/ui";
import { useRemoteDialogError, useRemoteStore, type RemotePhase } from "@/stores/remote-store";
import { useRemoteDialogStore } from "@/stores/remote-dialog-store";
import { desktopBridge } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { canPreventHostSleep, useRemotePreventSleep } from "@/lib/remote/sleep-prevention";
import { RemoteDisclosure, SectionHeading } from "./remote-ui";
import { RemoteLanSection } from "./RemoteLanSection";
import { RemotePairSection } from "./RemotePairSection";
import { RemoteTunnelSection } from "./RemoteTunnelSection";
import { RemoteDevicesSection } from "./RemoteDevicesSection";
import { RemoteActivitySection } from "./RemoteActivitySection";

/**
 * Host control surface for remote access. Opens from the sidebar button and
 * fetches the current status. Off, it explains what remote access gives and
 * offers to turn it on; on, a status line (with the off switch) sits over the
 * pairing QR and its steps, then the paired devices and the rest. Loopback
 * only: never rendered in a remote browser.
 */
export function RemoteAccessDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const status = useRemoteStore((s) => s.status);
  const loaded = useRemoteStore((s) => s.loaded);
  const phase = useRemoteStore((s) => s.phase);
  const error = useRemoteDialogError();
  const refresh = useRemoteStore((s) => s.refresh);
  const clearError = useRemoteStore((s) => s.clearError);

  // A new opening starts clean: a failure from the last time it was open is
  // not this one's.
  useEffect(() => {
    clearError();
    void refresh();
  }, [clearError, refresh]);

  // First fetch still in flight: a loader rather than a misleading "off".
  const initialLoading = !loaded && phase === "loading";
  const enabled = status?.enabled ?? false;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{t("remote.host.title", "Remote access")}</DialogTitle>
          <DialogDescription>
            {t("remote.host.subtitle", "Use this workspace from your phone or tablet.")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {initialLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("remote.host.checking", "Checking remote access…")}
            </div>
          ) : enabled && status ? (
            <RemoteOnView status={status} phase={phase} />
          ) : (
            <RemoteOffView phase={phase} />
          )}
          {error ? (
            <p role="alert" className="text-xs text-[var(--acc-red)]">
              {error}
            </p>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RemoteOffView({ phase }: { phase: RemotePhase }): ReactElement {
  const { t } = useUiTranslation();
  const enable = useRemoteStore((s) => s.enable);
  const turning = phase === "mutating";
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-8 text-center">
      <div className="grid size-11 place-items-center rounded-xl border border-border bg-background">
        <Smartphone className="size-5" aria-hidden />
      </div>
      <div className="space-y-1.5">
        <p className="text-base font-semibold">
          {t("remote.host.off.title", "Follow your agents from your phone")}
        </p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {t(
            "remote.host.off.body",
            "Turn it on, scan a code with your phone, and read, answer and start conversations from anywhere on your network.",
          )}
        </p>
      </div>
      <Button type="button" onClick={() => void enable()} disabled={phase !== "idle"}>
        {turning ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t("remote.host.off.enable", "Turn on remote access")}
      </Button>
      <p className="max-w-sm text-xs text-muted-foreground">
        {t(
          "remote.host.off.warning",
          "A paired device gets full access to this workspace. Turn it on only on networks you trust.",
        )}
      </p>
    </div>
  );
}

function RemoteOnView({
  status,
  phase,
}: {
  status: RemoteStatus;
  phase: RemotePhase;
}): ReactElement {
  return (
    <>
      <RemoteStatusLine status={status} phase={phase} />
      <RemotePairSection status={status} />
      <RemoteManageSections status={status} />
    </>
  );
}

/** "On", how many devices are paired and connected, and the off switch. */
function RemoteStatusLine({
  status,
  phase,
}: {
  status: RemoteStatus;
  phase: RemotePhase;
}): ReactElement {
  const { t } = useUiTranslation();
  const disable = useRemoteStore((s) => s.disable);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5">
      <span
        className="size-2.5 shrink-0 rounded-full bg-[var(--acc-green)] motion-safe:animate-pulse"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("remote.host.enabled", "Remote access is on")}</p>
        <p className="truncate text-xs text-muted-foreground">
          {status.devices.length === 0
            ? t("remote.host.status.noDevices", "No device paired yet")
            : t("remote.host.status.devices", {
                count: status.devices.length,
                connected: status.connected_devices,
                defaultValue_one:
                  "{{count, number}} device paired · {{connected, number}} connected",
                defaultValue_other:
                  "{{count, number}} devices paired · {{connected, number}} connected",
              })}
        </p>
      </div>
      {phase === "mutating" ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
      ) : null}
      <Switch
        checked
        disabled={phase !== "idle"}
        onCheckedChange={(next) => {
          if (!next) void disable();
        }}
        aria-label={t("remote.host.title", "Remote access")}
      />
    </div>
  );
}

/**
 * Paired devices, the stay-awake preference, and what is reference rather than
 * routine (addresses and certificate, tunnels, activity) folded away. The
 * "View devices" toast action scrolls to the devices (each toast bumps
 * `focusDevicesNonce`, consumed once scrolled so a later opening starts at the
 * pairing code).
 */
function RemoteManageSections({ status }: { status: RemoteStatus }): ReactElement {
  const { t } = useUiTranslation();
  const focusDevicesNonce = useRemoteDialogStore((s) => s.focusDevicesNonce);
  const devicesFocused = useRemoteDialogStore((s) => s.devicesFocused);
  const devicesRef = useRef<HTMLElement>(null);
  const devicesHeadingId = useId();

  useEffect(() => {
    if (focusDevicesNonce === 0) return;
    const raf = requestAnimationFrame(() => {
      devicesRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      devicesFocused();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusDevicesNonce, devicesFocused]);

  return (
    <div className="space-y-5 border-t border-border pt-5">
      <section ref={devicesRef} aria-labelledby={devicesHeadingId} className="space-y-2">
        <SectionHeading id={devicesHeadingId}>
          {t("remote.host.sections.pairedDevices", "Paired devices")}
        </SectionHeading>
        <RemoteDevicesSection status={status} />
      </section>
      {canPreventHostSleep(desktopBridge.isElectron, isBrowserRemote()) ? (
        <SleepPreventionRow />
      ) : null}
      <div className="space-y-2">
        <RemoteDisclosure title={t("remote.host.sections.addresses", "Addresses and certificate")}>
          <RemoteLanSection status={status} />
        </RemoteDisclosure>
        <RemoteDisclosure title={t("remote.host.sections.awayFromHome", "Use it away from home")}>
          <RemoteTunnelSection status={status} />
        </RemoteDisclosure>
        <RemoteDisclosure title={t("remote.host.sections.activity", "Recent activity")}>
          <RemoteActivitySection status={status} />
        </RemoteDisclosure>
      </div>
    </div>
  );
}

/**
 * Keep the host awake while hosting. Shown only on the desktop host (a paired
 * browser has no blocker to hold). The preference persists on its own; the
 * blocker is held only while remote access is on (see `useRemoteSleepGuard`).
 */
function SleepPreventionRow(): ReactElement {
  const { t } = useUiTranslation();
  const [preventSleep, setPreventSleep] = useRemotePreventSleep();
  const label = t("remote.host.keepAwake.title", "Keep this computer awake");
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="min-w-0 space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {t(
            "remote.host.keepAwake.description",
            "While remote access is on. The screen can still lock; closing the lid or a low battery still puts it to sleep.",
          )}
        </span>
      </span>
      <Switch checked={preventSleep} onCheckedChange={setPreventSleep} aria-label={label} />
    </label>
  );
}
