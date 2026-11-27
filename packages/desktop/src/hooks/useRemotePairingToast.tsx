import { useEffect } from "react";
import { toast } from "sonner";
import { takeJustPaired, takePairingError } from "@/api/remote-pairing";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { trustCurrentDevice } from "@/lib/remote/device-token";
import { formatPairingError, type PairingIssue } from "@/lib/remote/pairing-errors";

function PairingErrorMessage({ error }: { error: PairingIssue }) {
  const { t } = useUiTranslation();
  return formatPairingError(error, t);
}

const connectedMessage = (
  <UiTrans i18nKey="remote.pairing.connected" defaults="Connected to this workspace." />
);
const trustedMessage = (
  <UiTrans i18nKey="remote.pairing.trusted" defaults="This device will stay signed in." />
);

/**
 * One-shot pairing follow-ups for a remote-browser session (pairing runs before
 * React mounts — or before the gate's reload — so its outcome is stashed and
 * replayed here):
 *
 * - on failure, an error toast;
 * - after a session-only pair from a link (the Safari `#code=` flow), an offer
 *   to *stay signed in* — the "trust this device" decision lives on the device
 *   that paired, not in the host's link;
 * - after a pair from the pairing screen (e.g. an installed PWA), where its
 *   "Stay signed in" switch already decided, a plain confirmation saying
 *   whether the sign-in persists.
 *
 * No-op in the desktop shell or when there's nothing to replay.
 */
export function useRemotePairingToast(): void {
  useEffect(() => {
    const error = takePairingError();
    if (error) {
      toast.error(<PairingErrorMessage error={error} />);
      return;
    }
    const mode = takeJustPaired();
    if (mode === "trusted") {
      toast.success(connectedMessage, {
        description: trustedMessage,
      });
    } else if (mode === "session-chosen") {
      toast.success(connectedMessage, {
        description: (
          <UiTrans
            i18nKey="remote.pairing.sessionChosen"
            defaults="You'll pair again once this device closes Cadencr."
          />
        ),
      });
    } else if (mode === "session") {
      toast.success(connectedMessage, {
        // Actionable and easy to miss on mobile, so give it well beyond the
        // default dismiss window to read the question and tap "Stay signed in".
        duration: 15000,
        description: (
          <UiTrans
            i18nKey="remote.pairing.staySignedInDetail"
            defaults="Stay signed in on this device after closing the tab?"
          />
        ),
        action: {
          label: <UiTrans i18nKey="remote.pairing.staySignedIn" defaults="Stay signed in" />,
          onClick: () => {
            if (trustCurrentDevice()) toast.success(trustedMessage);
            else {
              toast.error(
                <UiTrans
                  i18nKey="remote.pairing.saveSignInFailed"
                  defaults="Couldn't save sign-in on this device."
                />,
              );
            }
          },
        },
      });
    }
  }, []);
}
