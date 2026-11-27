import { UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useId, useState, type ReactElement } from "react";
import type { RemoteStatus } from "@/api/generated";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionHeading } from "./remote-ui";
import { RemotePairingCode } from "./RemotePairingCode";

type TargetKind = "tunnel" | "tailscale" | "lan";

interface PairTarget {
  origin: string;
  kind: TargetKind;
}

function kindLabel(kind: TargetKind, t: UiTranslator): string {
  switch (kind) {
    case "tunnel":
      return t("remote.pairing.targets.tunnel", "Private tunnel");
    case "tailscale":
      return t("remote.pairing.targets.tailscale", "Tailscale");
    case "lan":
      return t("remote.pairing.targets.lan", "Local network");
  }
}

// Which address the QR offers first: a browser-trusted tunnel, then the local
// network most phones share with the computer, then Tailscale's.
const KIND_ORDER: Record<TargetKind, number> = { tunnel: 0, lan: 1, tailscale: 2 };

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** Tailscale hands out addresses in the carrier-grade NAT range, 100.64.0.0/10. */
function isTailscaleAddress(origin: string): boolean {
  const octets = new URL(origin).hostname.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function pairingTargets(status: RemoteStatus): PairTarget[] {
  const tunnelOrigin = status.tunnel_host ? httpsOrigin(`https://${status.tunnel_host}`) : null;
  const lanOrigins = status.lan_urls
    .map(httpsOrigin)
    .filter((origin): origin is string => origin !== null);
  const origins = [...new Set([...(tunnelOrigin ? [tunnelOrigin] : []), ...lanOrigins])];
  return origins
    .map((origin): PairTarget => {
      // A tunnel name that is also a listener address keeps the address's
      // self-signed certificate, so it is not treated as browser-trusted.
      if (origin === tunnelOrigin && !lanOrigins.includes(origin)) {
        return { origin, kind: "tunnel" };
      }
      return { origin, kind: isTailscaleAddress(origin) ? "tailscale" : "lan" };
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/**
 * Pair a device: the address picker, when the computer has several, over the
 * QR and its steps. Every address but a tunnel's serves the self-signed
 * certificate, so its steps carry that certificate's fingerprint.
 */
export function RemotePairSection({ status }: { status: RemoteStatus }): ReactElement {
  const { t } = useUiTranslation();
  const targets = pairingTargets(status);
  const [selected, setSelected] = useState("");
  const target = targets.find((entry) => entry.origin === selected) ?? targets[0];
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SectionHeading id={headingId}>
          {t("remote.pairing.section.title", "Pair a device")}
        </SectionHeading>
        {targets.length > 1 && target ? (
          <Select value={target.origin} onValueChange={setSelected}>
            <SelectTrigger
              size="sm"
              aria-label={t("remote.pairing.section.address", "Address the code points to")}
              className="max-w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {targets.map((entry) => (
                <SelectItem key={entry.origin} value={entry.origin}>
                  <span className="font-mono text-xs">{new URL(entry.origin).host}</span>
                  <span className="text-muted-foreground">· {kindLabel(entry.kind, t)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {target ? (
        <RemotePairingCode
          key={`${target.origin}|${status.fingerprint ?? ""}`}
          origin={target.origin}
          fingerprint={target.kind === "tunnel" ? null : (status.fingerprint ?? null)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          <UiTrans
            i18nKey="remote.pairing.section.noAddress"
            defaults="No network address found. Connect this computer to Wi-Fi, or set up a private tunnel under <name>Use it away from home</name>."
            components={{ name: <span className="font-medium text-foreground" /> }}
          />
        </p>
      )}
    </section>
  );
}
