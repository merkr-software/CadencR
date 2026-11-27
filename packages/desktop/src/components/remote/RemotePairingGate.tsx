import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useId,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { Loader2, QrCode, Radio } from "lucide-react";

import { CadencrLogo } from "@/components/CadencrLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { detectStandalone } from "@/hooks/useFullscreen";
import {
  isBrowserRemote,
  readDeviceToken,
  subscribeToDeviceRevocation,
} from "@/lib/remote/device-token";
import {
  extractPairingCode,
  pairRemoteDevice,
  takePairingError,
  takeUrlPairingCode,
} from "@/api/remote-pairing";
import { useBrowserInterfaceLanguage } from "@/lib/i18n/language-document";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import {
  formatPairingError,
  pairingIssueFromError,
  PairingError,
  type PairingIssue,
} from "@/lib/remote/pairing-errors";

// The scanner pulls in the camera plumbing + jsQR decoder, so it only loads
// when the user actually chooses to scan.
const QrPairingScanner = lazy(() =>
  import("./QrPairingScanner").then((m) => ({ default: m.QrPairingScanner })),
);

/**
 * Gate shown to an UNPAIRED remote browser. Normally the host's QR link carries
 * a `#code=` that pairs before React mounts, so this never appears. It exists
 * for the case the token is gone at launch — most importantly iOS "Add to Home
 * Screen": the home-screen app gets its OWN storage, so the sign-in made in
 * Safari isn't visible there. The user scans the host's code from here (or
 * pastes its link). Whether the sign-in outlives the app is chosen here, on
 * this device: on by default in a home-screen app, which iOS closes often.
 *
 * Pass-through on the desktop shell and on any already-paired device; a device
 * revoked while open comes back here.
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

/**
 * A new pairing link opened in this tab only changes its hash: no reload, so
 * the boot-time exchange never sees it. Read it here, and scrub it from the
 * address first (`takeUrlPairingCode`) so the single-use code never lingers,
 * even when it arrives during a pairing: the caller then drops that code, and
 * the pairing under way reloads the page or reports its own failure.
 */
function usePairingLinkInTab(handlers: {
  onIssue: (issue: PairingIssue) => void;
  onCode: (code: string) => void;
}): void {
  const onHashChange = useEffectEvent((): void => {
    const taken = takeUrlPairingCode();
    if (taken.kind === "error") handlers.onIssue(taken.issue);
    else if (taken.kind === "code") handlers.onCode(taken.code);
  });
  useEffect(() => {
    const listener = (): void => onHashChange();
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
}

function PairingScreen(): ReactNode {
  useBrowserInterfaceLanguage();
  const { t } = useUiTranslation();
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<PairingIssue | null>(null);
  const [scanning, setScanning] = useState(false);
  const [staySignedIn, setStaySignedIn] = useState(detectStandalone);

  // A failed boot-time pairing (a used or expired link) says why here.
  useEffect(() => {
    const startupError = takePairingError();
    if (startupError) setError(startupError);
  }, []);

  const runPair = async (code: string): Promise<void> => {
    setScanning(false);
    setPairing(true);
    setError(null);
    try {
      const paired = await pairRemoteDevice(code, { trust: staySignedIn, chosen: true });
      if (!paired.storagePersisted) throw new PairingError({ kind: "signInNotSaved" });
      // Reload once storage succeeded so bootstrap reads the saved token.
      location.reload();
    } catch (err) {
      setError(pairingIssueFromError(err));
      setPairing(false);
    }
  };

  usePairingLinkInTab({
    onIssue: setError,
    onCode: (code) => {
      if (!pairing) void runPair(code);
    },
  });

  if (scanning) {
    return (
      <Suspense
        fallback={
          <FullScreenSpinner
            label={t("remote.pairing.gate.openingCamera", "Opening the camera…")}
            dark
          />
        }
      >
        <QrPairingScanner
          onCode={(code) => void runPair(code)}
          onCancel={() => setScanning(false)}
        />
      </Suspense>
    );
  }
  if (pairing) {
    return (
      <FullScreenSpinner label={t("remote.pairing.gate.pairingDevice", "Pairing this device…")} />
    );
  }

  return (
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-7 bg-background px-6 py-10 text-center">
      <CadencrLogo className="size-12" />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">
          {t("remote.pairing.gate.title", "Pair this device")}
        </h1>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
          <UiTrans
            i18nKey="remote.pairing.gate.scanInstructions"
            defaults="On your computer, open <name>Remote access</name> (<icon/> at the bottom of Cadencr's sidebar), then scan the code it shows."
            components={{
              name: <span className="font-medium text-foreground" />,
              icon: (
                <Radio
                  className="inline size-3.5 align-[-2px]"
                  role="img"
                  aria-label={t("remote.pairing.gate.radioIcon", "the radio icon")}
                />
              ),
            }}
          />
        </p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-4">
        <Button
          type="button"
          className="h-12 w-full text-base"
          onClick={() => {
            setError(null);
            setScanning(true);
          }}
        >
          <QrCode className="size-5" aria-hidden />
          {t("remote.pairing.gate.scanCode", "Scan the code")}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {formatPairingError(error, t)}
          </p>
        ) : null}
        <StaySignedInRow checked={staySignedIn} onCheckedChange={setStaySignedIn} />
        <PasteLinkForm onCode={(code) => void runPair(code)} />
      </div>
    </div>
  );
}

/** Whether the sign-in outlives this tab or app; on by default in a home-screen app. */
function StaySignedInRow({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): ReactNode {
  const { t } = useUiTranslation();
  const stayHintId = useId();
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 text-left">
      <span className="min-w-0 space-y-0.5">
        <span className="block text-sm font-medium">
          {t("remote.pairing.staySignedIn", "Stay signed in")}
        </span>
        <span id={stayHintId} className="block text-xs text-muted-foreground">
          {t(
            "remote.pairing.gate.staySignedInHint",
            "Otherwise this device pairs again once it is closed.",
          )}
        </span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={t("remote.pairing.gate.staySignedInLabel", "Stay signed in on this device")}
        aria-describedby={stayHintId}
      />
    </label>
  );
}

/** The fallback for a device without a camera: the link copied on the computer. */
function PasteLinkForm({ onCode }: { onCode: (code: string) => void }): ReactNode {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  if (!open) {
    return (
      <Button
        type="button"
        variant="link"
        onClick={() => setOpen(true)}
        className="h-11 font-normal text-muted-foreground hover:text-foreground"
      >
        {t("remote.pairing.gate.pasteOpen", "No camera? Paste the pairing link")}
      </Button>
    );
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const code = extractPairingCode(value);
    if (code) onCode(code);
    else setInvalid(true);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 text-left">
      <Input
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        placeholder={t("remote.pairing.gate.pastePlaceholder", "Paste the link from Copy link")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        aria-label={t("remote.pairing.gate.pasteLabel", "Pairing link")}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
      />
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {t(
            "remote.pairing.gate.pasteInvalid",
            "That isn't a pairing link. Use Copy link under the code on your computer.",
          )}
        </p>
      ) : null}
      <Button type="submit" variant="raised" disabled={!value.trim()}>
        {t("remote.pairing.gate.pasteSubmit", "Pair with this link")}
      </Button>
    </form>
  );
}

function FullScreenSpinner({ label, dark = false }: { label: string; dark?: boolean }): ReactNode {
  return (
    <div
      role="status"
      className={
        dark
          ? "fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black text-sm text-white/80"
          : "flex min-h-dvh w-full flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
      }
    >
      <Loader2 className="size-6 animate-spin" aria-hidden />
      {label}
    </div>
  );
}
