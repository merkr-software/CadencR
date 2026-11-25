import { useEffect, useRef, useState, type ReactElement } from "react";
import jsQR from "jsqr";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBrowserUiLocale, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";

/**
 * Full-screen camera viewfinder that decodes a pairing QR code. Used by the
 * `RemotePairingGate` as an alternative to pasting the link: a device that lost
 * its token can re-pair by pointing its camera at the QR shown in the host's
 * Remote access dialog.
 *
 * Decoding runs off a throttled interval against a down-scaled frame (not every
 * animation frame) to keep the main thread cheap on phones. Requires a secure
 * context with camera permission — the remote app is served over HTTPS, so the
 * only failure modes are a denied permission or a browser without camera APIs,
 * both surfaced inline with the paste fallback always one tap away.
 */

// Decode cadence + working resolution: a static QR resolves within a frame or
// two, so ~7 checks/sec at ≤640px keeps jsQR's per-pass cost negligible.
const DECODE_INTERVAL_MS = 140;
const MAX_DECODE_DIMENSION = 640;

export interface QrPairingScannerProps {
  /** Called with the raw decoded text (a pairing URL or bare code). */
  onDetect: (text: string) => void;
  /** Called when the user dismisses the scanner without a result. */
  onCancel: () => void;
}

type CameraError = "unavailable" | "denied" | "failed";

function cameraErrorMessage(error: CameraError, t: UiTranslator): string {
  switch (error) {
    case "unavailable":
      return t(
        "remote.pairing.scanner.unavailable",
        "This browser can't open the camera here. Paste the link instead.",
      );
    case "denied":
      return t(
        "remote.pairing.scanner.permissionDenied",
        "Camera permission was denied. Allow it in your browser settings, or paste the link instead.",
      );
    case "failed":
      return t(
        "remote.pairing.scanner.failed",
        "Couldn't start the camera. Paste the link instead.",
      );
  }
}

function useQrCamera(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onDetect: (text: string) => void,
): CameraError | null {
  const [error, setError] = useState<CameraError | null>(null);
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const decodeFrame = (): void => {
      const video = videoRef.current;
      if (stopped || !video || !ctx || video.readyState < video.HAVE_ENOUGH_DATA) return;
      const scale = Math.min(
        1,
        MAX_DECODE_DIMENSION / Math.max(video.videoWidth, video.videoHeight),
      );
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      if (w === 0 || h === 0) return;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const result = jsQR(data, w, h, { inversionAttempts: "dontInvert" });
      if (result?.data) {
        stopped = true;
        clearInterval(timer);
        onDetectRef.current(result.data);
      }
    };

    const start = async (): Promise<void> => {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) {
        setError("unavailable");
        return;
      }
      try {
        stream = await media.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        timer = setInterval(decodeFrame, DECODE_INTERVAL_MS);
      } catch (err) {
        const denied =
          err instanceof DOMException &&
          (err.name === "NotAllowedError" || err.name === "SecurityError");
        setError(denied ? "denied" : "failed");
      }
    };

    void start();

    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    // Acquire once; `onDetect` is read through a ref to avoid camera restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return error;
}

export function QrPairingScanner({ onDetect, onCancel }: QrPairingScannerProps): ReactElement {
  const locale = useBrowserUiLocale();
  const { t } = useUiTranslation(locale);
  const videoRef = useRef<HTMLVideoElement>(null);
  const error = useQrCamera(videoRef, onDetect);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <video
        ref={videoRef}
        className="absolute inset-0 size-full object-cover"
        playsInline
        muted
        aria-label={t("remote.pairing.scanner.viewfinder", "Camera viewfinder")}
      />

      {/* Viewfinder frame to guide aim. */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="size-60 max-w-[70vw] rounded-2xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
      </div>

      <div className="relative z-10 flex items-center justify-between p-4">
        <p className="text-sm font-medium drop-shadow">
          {t("remote.pairing.scanner.aim", "Point at the QR code on your computer")}
        </p>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onCancel}
          className="text-white hover:bg-white/15 hover:text-white"
          aria-label={t("remote.pairing.scanner.cancel", "Cancel scan")}
        >
          <X className="size-5" />
        </Button>
      </div>

      {error && (
        <div className="relative z-10 mx-4 mb-4 mt-auto rounded-lg bg-black/70 p-4 text-center">
          <p role="alert" className="text-sm text-red-300">
            {cameraErrorMessage(error, t)}
          </p>
          <Button type="button" variant="secondary" className="mt-3" onClick={onCancel}>
            {t("remote.pairing.scanner.backToPaste", "Back to paste")}
          </Button>
        </div>
      )}
    </div>
  );
}
