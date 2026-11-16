import { useState, type FormEvent, type ReactElement } from "react";
import type { RemoteStatus } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyIconButton, SectionHeading } from "./remote-ui";
import { RemotePairingCode } from "./RemotePairingCode";

interface PairTarget {
  origin: string;
  tunnel: boolean;
}

function pairingTargets(status: RemoteStatus): PairTarget[] {
  const httpsOrigin = (value: string): string | null => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
    } catch {
      return null;
    }
  };
  const tunnelOrigin = status.tunnel_host ? httpsOrigin(`https://${status.tunnel_host}`) : null;
  const lanOrigins = status.lan_urls
    .map(httpsOrigin)
    .filter((origin): origin is string => origin !== null);
  const origins = [...(tunnelOrigin ? [tunnelOrigin] : []), ...lanOrigins];
  return [...new Set(origins)].map((origin) => ({
    origin,
    // Naming an existing LAN endpoint as a tunnel must not bypass its comparison.
    tunnel: origin === tunnelOrigin && !lanOrigins.includes(origin),
  }));
}

/** Never create or display a LAN pairing secret before the browser certificate is compared. */
export function RemotePairSection({ status }: { status: RemoteStatus }): ReactElement {
  const targets = pairingTargets(status);
  const [selected, setSelected] = useState("");
  const target = targets.find((entry) => entry.origin === selected) ?? targets[0];
  return (
    <section className="space-y-3">
      <SectionHeading>Pair a new device</SectionHeading>
      <p className="text-xs text-muted-foreground">
        Recommended: use a private Tailscale connection with a browser-trusted certificate. For a
        LAN connection, compare its certificate before sharing a pairing code.
      </p>
      {targets.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Connection address">
          {targets.map((entry) => (
            <Button
              key={entry.origin}
              type="button"
              size="sm"
              variant={entry === target ? "default" : "outline"}
              aria-pressed={entry === target}
              onClick={() => setSelected(entry.origin)}
            >
              {new URL(entry.origin).host}
              {entry.tunnel ? " · Private tunnel" : " · LAN"}
            </Button>
          ))}
        </div>
      ) : null}
      {target ? (
        <PairTargetGate
          key={`${target.origin}|${status.fingerprint ?? ""}`}
          target={target}
          fingerprint={status.fingerprint ?? null}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Connect to a network or configure a private tunnel to pair a device.
        </p>
      )}
    </section>
  );
}

function PairTargetGate({
  target,
  fingerprint,
}: {
  target: PairTarget;
  fingerprint: string | null;
}): ReactElement {
  const [verified, setVerified] = useState(false);
  if (target.tunnel) {
    return <RemotePairingCode origin={target.origin} fingerprint={null} />;
  }
  if (verified) return <RemotePairingCode origin={target.origin} fingerprint={fingerprint} />;
  return (
    <CertificateComparison
      origin={target.origin}
      fingerprint={fingerprint}
      onVerified={() => setVerified(true)}
    />
  );
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[\s:]/g, "").toUpperCase();
}

function CertificateComparison({
  origin,
  fingerprint,
  onVerified,
}: {
  origin: string;
  fingerprint: string | null;
  onVerified: () => void;
}): ReactElement {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const expected = normalizeFingerprint(fingerprint ?? "");
  const compare = (event: FormEvent): void => {
    event.preventDefault();
    if (!/^[A-F0-9]{64}$/.test(expected) || normalizeFingerprint(input) !== expected) {
      setError(
        "The SHA-256 fingerprint does not match. Do not pair; check the certificate and host again.",
      );
      return;
    }
    onVerified();
  };
  return (
    <form onSubmit={compare} className="space-y-3 rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">
        On the other device, open this address without a pairing code. In the browser's certificate
        viewer, find the certificate's SHA-256 fingerprint. Compare it with this host before
        accepting the certificate warning. Cadencr cannot inspect that browser's certificate.
      </p>
      <div className="flex items-center justify-between gap-2">
        <code className="break-all text-xs">{origin}/</code>
        <CopyIconButton value={`${origin}/`} successLabel="Certificate check URL copied" />
      </div>
      {fingerprint ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">Expected host SHA-256 fingerprint</p>
          <code className="block break-all font-mono text-[11px]">{fingerprint}</code>
        </div>
      ) : (
        <p role="alert" className="text-xs text-destructive">
          The host fingerprint is unavailable. Pairing is blocked.
        </p>
      )}
      <label htmlFor="remote-browser-fingerprint" className="block text-xs font-medium">
        SHA-256 fingerprint from the other device's browser
      </label>
      <Input
        id="remote-browser-fingerprint"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setError(null);
        }}
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the complete SHA-256 fingerprint"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={!fingerprint || !input.trim()}>
        Compare and show pairing code
      </Button>
    </form>
  );
}
