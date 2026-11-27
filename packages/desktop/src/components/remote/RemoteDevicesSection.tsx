import { useState, type ReactElement } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { RemoteDevice, RemoteStatus } from "@/api/generated";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { useUiTranslation } from "@/lib/i18n/ui";
import { useRemoteStore } from "@/stores/remote-store";
import { formatRemoteAge } from "./remote-ui";

/**
 * Paired devices with a per-row Revoke. Revoking sets `revoked_at`, force-closes
 * the device's live sockets, and refetches status — so the row disappears only
 * after the backend confirms (no optimistic removal).
 */
export function RemoteDevicesSection({ status }: { status: RemoteStatus }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <section className="space-y-2">
      {status.devices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("remote.devices.empty", "No devices paired yet. Use the code above to add one.")}
        </p>
      ) : (
        <ul className="space-y-1">
          {status.devices.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceRow({ device }: { device: RemoteDevice }): ReactElement {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  const label = device.label ?? t("remote.devices.unnamed", "Remote device");
  const revokeDevice = useRemoteStore((s) => s.revokeDevice);
  const [revoking, setRevoking] = useState(false);

  const onRevoke = async (): Promise<void> => {
    setRevoking(true);
    try {
      await revokeDevice(device.id);
    } finally {
      // The row unmounts on success; this only matters if revoke failed.
      setRevoking(false);
    }
  };

  return (
    <li className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2.5 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">
          {t("remote.devices.timestamps", "Last seen {{lastSeen}} · paired {{pairedAt}}", {
            lastSeen: formatRemoteAge(device.last_seen_at, t, locale),
            pairedAt: formatRemoteAge(device.created_at, t, locale),
          })}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void onRevoke()}
        disabled={revoking}
        title={t("remote.devices.revokeTitle", "Revoke this device")}
        aria-label={t("remote.devices.revokeNamed", "Revoke {{name}}", { name: label })}
        aria-busy={revoking}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-[var(--acc-red)] transition-colors hover:bg-[var(--acc-red)]/10 disabled:opacity-50"
      >
        {revoking ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="size-3.5" aria-hidden />
        )}
        {t("remote.devices.revoke", "Revoke")}
      </button>
    </li>
  );
}
