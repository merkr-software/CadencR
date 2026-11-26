import { memo, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, Copy, Loader2, RefreshCw } from "lucide-react";
import type { RemoteDevice } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { formatElapsed } from "@/lib/format-elapsed";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useRemoteStore } from "@/stores/remote-store";
import { deviceLabel } from "./remote-ui";
import { pairingCodeFailureMessage, usePairingCode, type PairingCode } from "./usePairingCode";

// The QR's side, and its quiet zone in modules: phone cameras need that light
// margin around the code to find it on a dark screen.
const QR_SIZE = 196;
const QR_QUIET_ZONE = 3;
// Bytes of the certificate fingerprint the steps quote: 8 bytes (64 bits) is
// out of reach of a forged certificate made to match, yet short to compare.
const QUOTED_FINGERPRINT_BYTES = 8;

/**
 * The pairing hero: the QR beside the steps to follow on the other device.
 * `fingerprint` is the self-signed certificate of a local-network address
 * (`null` for a tunnel with a browser-trusted one): the steps then warn that
 * the browser will say the connection is not private, and quote the start of
 * the fingerprint to recognise it in the warning's details.
 */
export function RemotePairingCode({
  origin,
  fingerprint,
}: {
  origin: string;
  fingerprint: string | null;
}): ReactElement {
  const { t } = useUiTranslation();
  const code = usePairingCode(origin, fingerprint);
  return (
    <div className="space-y-4">
      {code.paired !== undefined ? <PairedNotice code={code} /> : null}
      <div className="grid items-center gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-2">
          <QrPlate url={code.url} phase={code.phase} error={code.error} />
          {code.url ? (
            <CodeFooter url={code.url} expiresAt={code.expiresAt} lifetime={code.lifetime} />
          ) : code.phase === "minting" ? null : (
            <Button type="button" size="sm" variant="raised" onClick={code.renew}>
              <RefreshCw aria-hidden />
              {t("remote.pairing.code.showNew", "Show a new code")}
            </Button>
          )}
        </div>
        <PairingSteps fingerprint={fingerprint} />
      </div>
    </div>
  );
}

/** A device used the previous code: name it, and let the user revoke it if it isn't theirs. */
function PairedNotice({ code }: { code: PairingCode }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/10 px-3 py-2 text-sm"
    >
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--acc-green)]" aria-hidden />
      <p className="min-w-0 flex-1">
        <UiTrans
          i18nKey="remote.pairing.code.paired"
          defaults="<name>{{device}}</name> is paired."
          values={{
            device: code.paired
              ? deviceLabel(code.paired, t)
              : t("remote.pairing.code.aDevice", "A device"),
          }}
          components={{ name: <span className="font-medium" /> }}
        />
        {code.url
          ? ` ${t(
              "remote.pairing.code.pairAnother",
              "Scan the new code to pair another device, or its home-screen app.",
            )}`
          : null}
      </p>
      {code.paired ? <RevokeButton device={code.paired} onRevoked={code.dismissPaired} /> : null}
    </div>
  );
}

function RevokeButton({
  device,
  onRevoked,
}: {
  device: RemoteDevice;
  onRevoked: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const revokeDevice = useRemoteStore((s) => s.revokeDevice);
  const [revoking, setRevoking] = useState(false);
  const revoke = async (): Promise<void> => {
    setRevoking(true);
    await revokeDevice(device.id);
    setRevoking(false);
    // The store reports a failure in the dialog; the device is gone otherwise.
    if (!useRemoteStore.getState().status?.devices.some((d) => d.id === device.id)) onRevoked();
  };
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={() => void revoke()}
      disabled={revoking}
      className="shrink-0 text-muted-foreground"
    >
      {revoking ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {t("remote.pairing.code.notYou", "Not you? Revoke")}
    </Button>
  );
}

// Memoized: its props change only with the code, not with each countdown tick
// or status poll, and `QRCodeSVG` rebuilds its path on every render.
const QrPlate = memo(function QrPlate({
  url,
  phase,
  error,
}: {
  url: string | null;
  phase: PairingCode["phase"];
  error: PairingCode["error"];
}): ReactElement {
  const { t } = useUiTranslation();
  let content: ReactNode;
  if (url) {
    content = (
      <QRCodeSVG
        value={url}
        size={QR_SIZE}
        marginSize={QR_QUIET_ZONE}
        title={t("remote.pairing.code.qrTitle", "Pairing code")}
      />
    );
  } else if (phase === "minting") {
    content = (
      <Loader2
        className="size-5 animate-spin text-neutral-500"
        role="img"
        aria-label={t("remote.pairing.code.creating", "Creating a code")}
      />
    );
  } else if (phase === "error") {
    content = (
      <p role="alert" className="px-4 text-center text-xs text-[var(--acc-red)]">
        {error ? pairingCodeFailureMessage(t, error) : null}
      </p>
    );
  } else {
    content = (
      <p className="px-4 text-center text-xs text-neutral-600">
        {t(
          "remote.pairing.code.expired",
          "The code expired. Show a new one when you are ready to scan.",
        )}
      </p>
    );
  }
  // White plate whatever the theme: the code needs dark modules on a light field.
  return (
    <div
      className="grid place-items-center overflow-hidden rounded-xl bg-white shadow-xs"
      style={{ width: QR_SIZE, height: QR_SIZE }}
    >
      {content}
    </div>
  );
});

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - performance.now()) / 1000));
}

/** The code's countdown (its own ticker, so only this line re-renders) and Copy link. */
function CodeFooter({
  url,
  expiresAt,
  lifetime,
}: {
  url: string;
  expiresAt: number;
  lifetime: number;
}): ReactElement {
  const { t } = useUiTranslation();
  const [remaining, setRemaining] = useState(() => secondsLeft(expiresAt));
  useEffect(() => {
    setRemaining(secondsLeft(expiresAt));
    const id = setInterval(() => setRemaining(secondsLeft(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return (
    <div className="flex w-full flex-col gap-1.5" style={{ maxWidth: QR_SIZE }}>
      <div
        className="h-0.5 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={t("remote.pairing.code.lifetime", "Code lifetime")}
        aria-valuemin={0}
        aria-valuemax={lifetime}
        aria-valuenow={remaining}
      >
        <div
          className="h-full origin-left bg-[var(--acc-green)] transition-transform duration-1000 ease-linear"
          style={{ transform: `scaleX(${remaining / lifetime})` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {t("remote.pairing.code.newIn", "New code in {{time}}", {
            time: formatElapsed(remaining * 1000),
          })}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            void copyToClipboard(url, t("remote.pairing.code.linkCopied", "Pairing link copied"))
          }
          className="text-[11px] font-normal text-muted-foreground"
        >
          <Copy aria-hidden />
          {t("remote.pairing.code.copyLink", "Copy link")}
        </Button>
      </div>
    </div>
  );
}

function PairingSteps({ fingerprint }: { fingerprint: string | null }): ReactElement {
  const { t } = useUiTranslation();
  const quoted = fingerprint?.split(":").slice(0, QUOTED_FINGERPRINT_BYTES).join(":");
  return (
    <ol
      className="space-y-3.5 text-sm"
      aria-label={t("remote.pairing.steps.label", "How to pair a device")}
    >
      <Step n={1} title={t("remote.pairing.steps.scan", "Scan the code with your phone's camera")}>
        {t(
          "remote.pairing.steps.scanDetail",
          "Or open the copied link in a browser on the other device.",
        )}
      </Step>
      {quoted ? (
        <Step n={2} title={t("remote.pairing.steps.warning", "Continue past the privacy warning")}>
          <UiTrans
            i18nKey="remote.pairing.steps.warningDetail"
            defaults="This computer signs its own certificate, so the browser warns once. In the warning's details, its SHA-256 fingerprint starts with <fingerprint>{{fingerprint}}</fingerprint>."
            values={{ fingerprint: quoted }}
            components={{
              fingerprint: <code className="font-mono text-[11px] break-all text-foreground" />,
            }}
          />
        </Step>
      ) : null}
      <Step
        n={quoted ? 3 : 2}
        title={t("remote.pairing.steps.homeScreen", "Optional: add it to your Home Screen")}
      >
        <UiTrans
          i18nKey="remote.pairing.steps.homeScreenDetail"
          defaults="For a full-screen app. It asks to pair once more: tap <em>Scan the code</em> in it and scan this code again."
          components={{ em: <em /> }}
        />
      </Step>
    </ol>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <li className="flex gap-3">
      <span
        className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold tabular-nums text-secondary-foreground"
        aria-hidden
      >
        {n}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium leading-5">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}
