import { useEffect, useRef, useState, type ReactElement } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, Loader2, QrCode, RefreshCw } from "lucide-react";
import { remotePairingCode } from "@/api/generated";
import { z } from "zod";
import { useRemoteStore } from "@/stores/remote-store";
import { CopyIconButton } from "./remote-ui";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";

// While a live code is on screen, re-poll status so we notice the moment a
// device pairs with it (the code is single-use, so the QR is then dead).
const USED_POLL_MS = 3000;
const pairingCodeResponse = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]+$/),
  expires_in_secs: z.number().int().positive(),
  fingerprint: z.string(),
  urls: z.array(
    z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }),
  ),
});

/**
 * Mint a short-lived, single-use pairing code and present it as a QR + link.
 * The QR encodes the connect URL (which carries the code) — never a device
 * token. The host offers every reachable address (each LAN interface, plus the
 * tunnel host when configured); the user picks which one the QR points at. The
 * code is held only in this component's state and expires on a countdown, after
 * which the QR is cleared so it can't be scanned stale. Whether the paired
 * device stays signed in is decided on that device, not here.
 */
export function RemotePairingCode({
  origin,
  fingerprint,
}: {
  origin: string;
  fingerprint: string | null;
}): ReactElement {
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [used, setUsed] = useState(false);
  const autoMinted = useRef(false);
  // Guards the consumed signal against a stale status snapshot left over from a
  // *previous* code: we only trust "consumed" once we've seen this code reported
  // "pending" at least once. Reset on every mint.
  const sawPending = useRef(false);

  const refresh = useRemoteStore((s) => s.refresh);
  const pairingState = useRemoteStore((s) => s.status?.pairing_state);

  const mint = async (): Promise<void> => {
    setMinting(true);
    setError(null);
    setUsed(false);
    sawPending.current = false;
    try {
      const parsed = pairingCodeResponse.safeParse(await remotePairingCode());
      if (!parsed.success) throw new Error("Malformed pairing-code response.");
      const result = parsed.data;
      if (fingerprint && result.fingerprint !== fingerprint) {
        throw new Error(
          "The host certificate changed. Close and reopen Remote access, then verify it again.",
        );
      }
      const matched = result.urls.find((url) => new URL(url).origin === origin);
      if (!matched)
        throw new Error("This connection address changed. Choose it again before pairing.");
      const url = new URL(matched);
      url.searchParams.delete("code");
      url.searchParams.delete("trust");
      url.hash = `code=${encodeURIComponent(result.code)}`;
      setPairingUrl(url.toString());
      setRemaining(result.expires_in_secs);
      // Pull status now so the store reflects this fresh code as "pending"
      // promptly (the 3s poll alone could otherwise miss it before a fast scan).
      void refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not create a pairing code."));
      setPairingUrl(null);
    } finally {
      setMinting(false);
    }
  };

  // Pairing is the dialog's primary action, so mint a code on mount and show
  // the QR straight away — no extra click. The ref guards against React Strict
  // Mode's double-invoke (which would otherwise burn a second single-use code).
  useEffect(() => {
    if (autoMinted.current) return;
    autoMinted.current = true;
    void mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Tick the countdown; drop the code at zero so a stale QR can't be scanned.
  useEffect(() => {
    if (!pairingUrl) return;
    if (remaining <= 0) {
      setPairingUrl(null);
      return;
    }
    const timer = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [pairingUrl, remaining]);

  // Poll status while a live code is shown so we can detect it being consumed.
  useEffect(() => {
    if (!pairingUrl || used) return;
    const id = setInterval(() => void refresh(), USED_POLL_MS);
    return () => clearInterval(id);
  }, [pairingUrl, used, refresh]);

  // The host reports the current code's lifecycle directly. Once we've observed
  // it "pending" (so we're not reacting to a prior code's leftover state), a
  // "consumed" report means this single-use code was just used: retire the QR.
  useEffect(() => {
    if (!pairingUrl || used) return;
    if (pairingState === "pending") sawPending.current = true;
    else if (pairingState === "consumed" && sawPending.current) setUsed(true);
  }, [pairingUrl, used, pairingState]);

  return (
    <section className="space-y-2">
      {used ? (
        <UsedNotice minting={minting} onRegenerate={() => void mint()} />
      ) : pairingUrl ? (
        <PairingCodeView
          url={pairingUrl}
          remaining={remaining}
          onRegenerate={() => void mint()}
          minting={minting}
        />
      ) : (
        <GeneratePrompt minting={minting} error={error} onGenerate={() => void mint()} />
      )}
    </section>
  );
}

/**
 * Shown after a code is consumed. The code is single-use by design, so rather
 * than silently leaving a dead QR up (which would just fail on the next device),
 * we say so and require an explicit click to mint a fresh one — no auto-regen.
 */
function UsedNotice({
  minting,
  onRegenerate,
}: {
  minting: boolean;
  onRegenerate: () => void;
}): ReactElement {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5 rounded border border-border bg-card px-2.5 py-2 text-xs text-muted-foreground">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-green)]" aria-hidden />
        <span>
          This code paired a device and is now used up. Each code works once — generate a new one to
          pair another device.
        </span>
      </div>
      <Button
        type="button"
        onClick={onRegenerate}
        disabled={minting}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {minting ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <QrCode className="size-3.5" aria-hidden />
        )}
        Generate a new code
      </Button>
    </div>
  );
}

function GeneratePrompt({
  minting,
  error,
  onGenerate,
}: {
  minting: boolean;
  error: string | null;
  onGenerate: () => void;
}): ReactElement {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Generate a code, then scan the QR or open the link on the other device. The code is
        single-use and expires shortly.
      </p>
      <Button
        type="button"
        onClick={onGenerate}
        disabled={minting}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {minting ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <QrCode className="size-3.5" aria-hidden />
        )}
        Generate pairing code
      </Button>
      {error ? <p className="text-xs text-[var(--acc-red)]">{error}</p> : null}
    </div>
  );
}

function PairingCodeView({
  url,
  remaining,
  onRegenerate,
  minting,
}: {
  url: string;
  remaining: number;
  onRegenerate: () => void;
  minting: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3">
      {/* The QR is the primary action — large and centered. White plate so it
          scans on any theme (dark modules need a light field). */}
      <div className="rounded-md bg-white p-3">
        <QRCodeSVG value={url} size={200} marginSize={0} />
      </div>
      {/* URL + copy sit below the QR as the secondary, type-it-in fallback. */}
      <div className="flex w-full items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1">
        <code className="truncate font-mono text-[11px]">{url}</code>
        <CopyIconButton value={url} successLabel="Pairing link copied" />
      </div>
      <div className="flex w-full items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular-nums">Expires in {remaining}s</span>
        <Button
          type="button"
          onClick={onRegenerate}
          disabled={minting}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`size-3 ${minting ? "animate-spin" : ""}`} aria-hidden />
          New code
        </Button>
      </div>
    </div>
  );
}
