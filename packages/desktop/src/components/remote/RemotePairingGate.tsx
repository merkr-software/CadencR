import { lazy, Suspense, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, QrCode } from "lucide-react";

import { CadencrLogo } from "@/components/CadencrLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isBrowserRemote, readDeviceToken } from "@/lib/remote/device-token";
import { extractPairingCode, pairRemoteDevice } from "@/api/remote-pairing";
import { apiErrorMessage } from "@/lib/api-errors";

// The scanner pulls in the camera plumbing + jsQR decoder, so it only loads
// when the user actually chooses to scan rather than paste.
const QrPairingScanner = lazy(() =>
  import("./QrPairingScanner").then((m) => ({ default: m.QrPairingScanner })),
);

/**
 * Gate shown to an UNPAIRED remote browser. Normally the host's QR link carries
 * a `#code=` that pairs before React mounts, so this never appears. It exists
 * for the case the token is gone at launch — most importantly iOS "Add to Home
 * Screen": the standalone web-clip gets its OWN storage sandbox, so the token
 * paired in Safari isn't visible and every request 401s. Here the user pastes
 * the pairing link once. Sign-in lasts for this tab unless the user explicitly
 * chooses to stay signed in after pairing.
 *
 * Pass-through on the desktop shell and on any already-paired device.
 */
export function RemotePairingGate({ children }: { children: ReactNode }): ReactNode {
  if (!isBrowserRemote() || readDeviceToken()) return children;
  return <PairingScreen />;
}

export { extractPairingCode } from "@/api/remote-pairing";

function PairingScannerScreen({
  onDetect,
  onCancel,
}: {
  onDetect: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-50 grid place-items-center bg-black">
          <Loader2 className="size-6 animate-spin text-white" aria-hidden />
        </div>
      }
    >
      <QrPairingScanner onDetect={onDetect} onCancel={onCancel} />
    </Suspense>
  );
}

function PairingScreen(): ReactNode {
  const [value, setValue] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Shared by both the paste form and the QR scanner — `rawCode` is a pasted
  // link, a bare `?code=…`, or the URL decoded from a scanned QR.
  const runPair = async (rawCode: string): Promise<void> => {
    const code = extractPairingCode(rawCode);
    if (!code) {
      setScanning(false);
      setError("Paste the pairing link or code from your computer.");
      return;
    }
    setScanning(false);
    setPairing(true);
    setError(null);
    try {
      const paired = await pairRemoteDevice(code);
      if (!paired.storagePersisted) {
        throw new Error("Paired, but this browser couldn't save the sign-in. Try another browser.");
      }
      // Reload once session storage succeeded so bootstrap reads the saved token.
      location.reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Pairing failed."));
      setPairing(false);
    }
  };

  if (scanning) {
    return (
      <PairingScannerScreen
        onDetect={(text) => void runPair(text)}
        onCancel={() => setScanning(false)}
      />
    );
  }

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void runPair(value);
  };

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <CadencrLogo className="size-12" />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold">Pair this device</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Open <span className="font-medium text-foreground">Remote access</span> on your computer,
          then scan the QR code — or paste the pairing link below.
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full max-w-sm"
        disabled={pairing}
        onClick={() => {
          setError(null);
          setScanning(true);
        }}
      >
        <QrCode className="size-4" />
        Scan QR code
      </Button>

      <div className="flex w-full max-w-sm items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or paste the link
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste pairing link…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={pairing}
          aria-label="Pairing link or code"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pairing || !value.trim()}>
          {pairing ? "Pairing…" : "Pair device"}
        </Button>
      </form>
    </div>
  );
}
