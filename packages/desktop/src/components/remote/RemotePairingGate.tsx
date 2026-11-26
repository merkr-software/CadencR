import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { Loader2, QrCode } from "lucide-react";

import { CadencrLogo } from "@/components/CadencrLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isBrowserRemote,
  readDeviceToken,
  subscribeToDeviceRevocation,
} from "@/lib/remote/device-token";
import { extractPairingCode, pairRemoteDevice, takePairingError } from "@/api/remote-pairing";
import { useBrowserInterfaceLanguage } from "@/lib/i18n/language-document";
import { UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import {
  formatPairingError,
  pairingIssueFromError,
  type PairingIssue,
} from "@/lib/remote/pairing-errors";

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
  return isBrowserRemote() ? <BrowserPairingGate>{children}</BrowserPairingGate> : children;
}

function BrowserPairingGate({ children }: { children: ReactNode }): ReactNode {
  const paired = useSyncExternalStore(subscribeToDeviceRevocation, () =>
    Boolean(readDeviceToken()),
  );
  return paired ? children : <PairingScreen />;
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

function PairingInstructions({ t }: { t: UiTranslator }): ReactNode {
  return (
    <div className="space-y-1.5">
      <h1 className="text-lg font-semibold">
        {t("remote.pairing.gate.title", "Pair this device")}
      </h1>
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
        <UiTrans
          t={t}
          i18nKey="remote.pairing.gate.instructions"
          defaults="Open <setting>Remote access</setting> on your computer, then scan the QR code — or paste the pairing link below."
          components={{ setting: <span className="font-medium text-foreground" /> }}
        />
      </p>
    </div>
  );
}

function PairingScreen(): ReactNode {
  useBrowserInterfaceLanguage();
  const { t } = useUiTranslation();
  const [value, setValue] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<PairingIssue | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const startupError = takePairingError();
    if (startupError) setError(startupError);
  }, []);

  // Shared by both the paste form and the QR scanner — `rawCode` is a pasted
  // link, a bare `?code=…`, or the URL decoded from a scanned QR.
  const runPair = async (rawCode: string): Promise<void> => {
    const code = extractPairingCode(rawCode);
    setScanning(false);
    if (!code) {
      setError({ kind: "invalidInput" });
      return;
    }
    setPairing(true);
    setError(null);
    try {
      const paired = await pairRemoteDevice(code);
      if (paired.storagePersisted) {
        // Reload once session storage succeeded so bootstrap reads the saved token.
        location.reload();
        return;
      }
      setError({ kind: "signInNotSaved" });
    } catch (err) {
      setError(pairingIssueFromError(err));
    }
    setPairing(false);
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
      <PairingInstructions t={t} />

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
        {t("remote.pairing.gate.scan", "Scan QR code")}
      </Button>

      <div className="flex w-full max-w-sm items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {t("remote.pairing.gate.pasteAlternative", "or paste the link")}
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("remote.pairing.gate.placeholder", "Paste pairing link…")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={pairing}
          aria-label={t("remote.pairing.gate.inputLabel", "Pairing link or code")}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {formatPairingError(error, t)}
          </p>
        )}
        <Button type="submit" disabled={pairing || !value.trim()}>
          {pairing
            ? t("remote.pairing.gate.pairing", "Pairing…")
            : t("remote.pairing.gate.submit", "Pair device")}
        </Button>
      </form>
    </div>
  );
}
