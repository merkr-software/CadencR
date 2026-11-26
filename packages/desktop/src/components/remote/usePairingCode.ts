import { useEffect, useEffectEvent, useRef, useState } from "react";
import { z } from "zod";
import { remotePairingCode, type RemoteDevice } from "@/api/generated";
import { PAIRING_CODE_PATTERN, pairingLink } from "@/api/remote-pairing";
import { apiErrorMessage } from "@/lib/api-errors";
import type { UiTranslator } from "@/lib/i18n/ui";
import { readRemoteHostErrorDetails } from "@/lib/remote/host-errors";
import { useRemoteStore } from "@/stores/remote-store";

// While a live code is on screen, re-poll status so we notice the moment a
// device pairs with it (the code is single-use, so the QR is then dead).
const USED_POLL_MS = 3000;
// An open dialog renews an expired code on its own this many times (about ten
// minutes of codes), then waits for a click so an idle dialog stops minting.
const MAX_AUTO_RENEWALS = 4;

const pairingCodeResponse = z.object({
  code: z.string().regex(PAIRING_CODE_PATTERN),
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

type PairingCodeValidationFailure = { kind: "malformed" | "certificateChanged" | "addressChanged" };

/** Why no code is on screen. */
export type PairingCodeFailure =
  | PairingCodeValidationFailure
  | { kind: "disabled" }
  | { kind: "request"; detail: string };

export function pairingCodeFailureMessage(t: UiTranslator, failure: PairingCodeFailure): string {
  switch (failure.kind) {
    case "malformed":
      return t("remote.pairing.code.errors.malformed", "Malformed pairing-code response.");
    case "certificateChanged":
      return t(
        "remote.pairing.code.errors.certificateChangedReopen",
        "This computer's certificate changed. Close and reopen Remote access.",
      );
    case "addressChanged":
      return t(
        "remote.pairing.code.errors.addressGone",
        "This address is no longer available. Pick another one.",
      );
    case "disabled":
      return t(
        "remote.pairing.code.errors.disabled",
        "Conflict: Enable remote access before pairing",
      );
    case "request":
      return (
        failure.detail ||
        t("remote.pairing.code.errors.request", "Could not create a pairing code.")
      );
  }
}

/** `minting` until the first code, `live` while one is on screen. */
export type PairingCodePhase = "minting" | "live" | "expired" | "error";

export interface PairingCode {
  phase: PairingCodePhase;
  /** The link the QR encodes, while `live`. */
  url: string | null;
  /** When the code on screen expires (`performance.now()` ms), and its whole lifetime (s). */
  expiresAt: number;
  lifetime: number;
  error: PairingCodeFailure | null;
  /**
   * A device used a previous code: the device, once the status lists it
   * (`null` until then), or `undefined` when nothing paired.
   */
  paired: RemoteDevice | null | undefined;
  /** Forget the paired device (it was revoked). */
  dismissPaired: () => void;
  /** Mint a new code now (and restart the automatic renewals). */
  renew: () => void;
}

/** The newest device not among `before`: ids only grow, so the latest pairing. */
function newDevice(
  devices: readonly RemoteDevice[] | undefined,
  before: ReadonlySet<number>,
): RemoteDevice | null {
  return (devices ?? []).reduce<RemoteDevice | null>(
    (found, device) =>
      !before.has(device.id) && (!found || device.id > found.id) ? device : found,
    null,
  );
}

class InvalidPairingCode extends Error {
  constructor(readonly failure: PairingCodeValidationFailure) {
    super(failure.kind);
  }
}

/**
 * Mint a code and build the link to `origin` it pairs through. Throws when the
 * host's certificate is no longer `fingerprint` or `origin` is gone.
 */
async function mintPairingLink(
  origin: string,
  fingerprint: string | null,
): Promise<{ link: string; lifetime: number }> {
  const parsed = pairingCodeResponse.safeParse(await remotePairingCode());
  if (!parsed.success) throw new InvalidPairingCode({ kind: "malformed" });
  const result = parsed.data;
  if (fingerprint && result.fingerprint !== fingerprint) {
    throw new InvalidPairingCode({ kind: "certificateChanged" });
  }
  const matched = result.urls.find((value) => new URL(value).origin === origin);
  if (!matched) throw new InvalidPairingCode({ kind: "addressChanged" });
  return { link: pairingLink(matched, result.code), lifetime: result.expires_in_secs };
}

function mintFailure(err: unknown): PairingCodeFailure {
  if (err instanceof InvalidPairingCode) return err.failure;
  return readRemoteHostErrorDetails(err)?.code === "REMOTE_PAIRING_DISABLED"
    ? { kind: "disabled" }
    : { kind: "request", detail: apiErrorMessage(err, "") };
}

/**
 * The device that used a code: `notePaired(before)` with the device ids known
 * before it; the device is named once a status lists it (the newest id not in
 * `before`), and forgotten once it is gone (revoked from the list, say).
 */
function usePairedDevice(devices: readonly RemoteDevice[] | undefined): {
  paired: RemoteDevice | null | undefined;
  notePaired: (before: ReadonlySet<number>) => void;
  dismiss: () => void;
} {
  const [pairedAfter, setPairedAfter] = useState<ReadonlySet<number> | null>(null);
  const [pairedId, setPairedId] = useState<number | null>(null);
  const listed = pairedId !== null ? devices?.find((d) => d.id === pairedId) : undefined;
  const candidate = pairedAfter && pairedId === null ? newDevice(devices, pairedAfter) : null;
  useEffect(() => {
    if (candidate) setPairedId(candidate.id);
    else if (pairedId !== null && !listed) {
      setPairedAfter(null);
      setPairedId(null);
    }
  }, [candidate, pairedId, listed]);
  return {
    paired: pairedAfter ? (listed ?? candidate) : undefined,
    notePaired: (before) => {
      setPairedAfter(before);
      setPairedId(null);
    },
    dismiss: () => {
      setPairedAfter(null);
      setPairedId(null);
    },
  };
}

/**
 * A short-lived, single-use pairing code for `origin`, kept on screen while the
 * dialog is open: minted on mount, renewed when it expires (up to
 * `MAX_AUTO_RENEWALS` times) and right after a device uses it, so the next
 * device, or the same phone's home-screen app which pairs on its own, can scan
 * at once. The QR encodes the connect URL carrying the code in its fragment,
 * never a device token. `fingerprint` is the certificate the status reported:
 * a mint answering with another one means the host's certificate changed under
 * the dialog, and no code is shown.
 *
 * A code counts as used when a status *requested after it was minted* says
 * "consumed" (`statusAt`), so a status about the previous code never retires
 * the new one, and a scan faster than the poll is still caught by the next.
 */
export function usePairingCode(origin: string, fingerprint: string | null): PairingCode {
  const [phase, setPhase] = useState<PairingCodePhase>("minting");
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [lifetime, setLifetime] = useState(1);
  const [error, setError] = useState<PairingCodeFailure | null>(null);
  const renewals = useRef(0);
  const mintSeq = useRef(0);
  const mintedAt = useRef(0);
  const knownIds = useRef<ReadonlySet<number>>(new Set());
  const autoMinted = useRef(false);

  const refresh = useRemoteStore((s) => s.refresh);
  const pairingState = useRemoteStore((s) => s.status?.pairing_state);
  const statusAt = useRemoteStore((s) => s.statusAt);
  const devices = useRemoteStore((s) => s.status?.devices);
  const { paired, notePaired, dismiss } = usePairedDevice(devices);

  // A newer mint supersedes an older one still in flight: only the last code
  // minted is valid server-side, so only its answer may reach the screen.
  const mint = async (): Promise<void> => {
    const seq = ++mintSeq.current;
    setPhase("minting");
    setError(null);
    try {
      const minted = await mintPairingLink(origin, fingerprint);
      if (seq !== mintSeq.current) return;
      mintedAt.current = performance.now();
      const listed = useRemoteStore.getState().status?.devices ?? [];
      knownIds.current = new Set(listed.map((device) => device.id));
      setUrl(minted.link);
      setLifetime(minted.lifetime);
      setExpiresAt(mintedAt.current + minted.lifetime * 1000);
      setPhase("live");
      void refresh();
    } catch (err) {
      if (seq !== mintSeq.current) return;
      setError(mintFailure(err));
      setUrl(null);
      setPhase("error");
    }
  };

  // The ref guards against Strict Mode's double effect, which would burn a
  // second single-use code.
  const mintOnMount = useEffectEvent(() => void mint());
  useEffect(() => {
    if (autoMinted.current) return;
    autoMinted.current = true;
    mintOnMount();
  }, []);

  // At expiry, check first whether a device used the code since the last poll
  // (its notice is due), then renew the code, or drop it once renewals ran
  // out so a stale QR is never left up.
  const expire = useEffectEvent(async () => {
    await refresh();
    const latest = useRemoteStore.getState();
    if (latest.status?.pairing_state === "consumed" && latest.statusAt > mintedAt.current) {
      consumed();
    } else if (renewals.current < MAX_AUTO_RENEWALS) {
      renewals.current += 1;
      void mint();
    } else {
      setUrl(null);
      setPhase("expired");
    }
  });
  useEffect(() => {
    if (phase !== "live") return;
    const timer = setTimeout(() => void expire(), Math.max(0, expiresAt - performance.now()));
    return () => clearTimeout(timer);
  }, [phase, expiresAt]);

  useEffect(() => {
    if (phase !== "live") return;
    const id = setInterval(() => void refresh(), USED_POLL_MS);
    return () => clearInterval(id);
  }, [phase, refresh]);

  function consumed(): void {
    notePaired(knownIds.current);
    renewals.current = 0;
    void mint();
  }
  const onStatus = useEffectEvent(() => {
    if (statusAt <= mintedAt.current) return;
    if (pairingState === "consumed") consumed();
    // The service lists devices before it reads the code's state, so a status
    // still "pending" lists every device but this code's: one that used the
    // previous code but was not listed when this one was minted joins here.
    else if (pairingState === "pending") {
      knownIds.current = new Set([...knownIds.current, ...(devices ?? []).map((d) => d.id)]);
    }
  });
  useEffect(() => {
    if (phase === "live") onStatus();
  }, [phase, pairingState, statusAt]);

  return {
    phase,
    url: phase === "live" ? url : null,
    expiresAt,
    lifetime,
    error,
    paired,
    dismissPaired: dismiss,
    renew: () => {
      renewals.current = 0;
      void mint();
    },
  };
}
