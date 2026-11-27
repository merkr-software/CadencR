import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import jsQR from "jsqr";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { pairingCodeFromScan } from "@/api/remote-pairing";

/**
 * Full-screen camera viewfinder that reads the pairing QR shown in the host's
 * Remote access dialog. Used by `RemotePairingGate`, typically in a home-screen
 * app that has to pair on its own.
 *
 * A laptop's QR is small in a phone's view: the camera is asked for a large
 * frame, and every other pass decodes the centre of it at full resolution
 * (where the viewfinder square asks the user to aim) rather than the whole
 * frame shrunk, which left too few pixels per module to read; one pass in
 * three reads the whole frame, for a code held close. Each pass is at most
 * `MAX_DECODE_DIMENSION` pixels a side and the next one is scheduled after it
 * ends, never on a fixed interval, so a slow phone is not kept busy back to
 * back. A QR that is not a pairing link says so and the scan goes on; no code
 * after a while brings a hint on distance.
 */

/** The pause between two passes, at least; a slow pass lengthens it. */
const DECODE_INTERVAL_MS = 120;
/** One pass in this many reads the whole frame, the others its centre. */
const FULL_FRAME_EVERY = 3;
const MAX_DECODE_DIMENSION = 800;
/** Share of the frame's short side the centre pass reads (the viewfinder square). */
const CENTRE_SHARE = 0.7;
const HINT_AFTER_MS = 8000;
const FOREIGN_CODE_NOTICE_MS = 3000;

export interface QrPairingScannerProps {
  /** Called once with the code of a scanned pairing link. */
  onCode: (code: string) => void;
  /** Called when the user dismisses the scanner without a result. */
  onCancel: () => void;
}

type ScanNotice = "none" | "foreign-code" | "hint";

/** A canvas per pass kind, so its bitmap is sized once, not reallocated every pass. */
interface PassCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
}

function passCanvas(): PassCanvas {
  const canvas = document.createElement("canvas");
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
}

/** Decode one pass: the frame's centre at full resolution, or the whole frame shrunk. */
function decodeFrame(video: HTMLVideoElement, target: PassCanvas, centre: boolean): string | null {
  const { videoWidth: vw, videoHeight: vh } = video;
  const { canvas, ctx } = target;
  if (vw === 0 || vh === 0 || !ctx) return null;
  const side = centre ? Math.round(Math.min(vw, vh) * CENTRE_SHARE) : 0;
  const [sx, sy, sw, sh] = centre ? [(vw - side) / 2, (vh - side) / 2, side, side] : [0, 0, vw, vh];
  const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  const result = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
    inversionAttempts: "dontInvert",
  });
  return result?.data || null;
}

type CameraError = "unavailable" | "denied" | "failed";

function cameraError(err: unknown): CameraError {
  const denied =
    err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
  return denied ? "denied" : "failed";
}

function cameraErrorMessage(error: CameraError, t: UiTranslator): string {
  switch (error) {
    case "unavailable":
      return t(
        "remote.pairing.scanner.unavailableLink",
        "This browser can't open the camera here. Paste the pairing link instead.",
      );
    case "denied":
      return t(
        "remote.pairing.scanner.deniedLink",
        "Camera access was denied. Allow it in your browser's settings, or paste the pairing link instead.",
      );
    case "failed":
      return t(
        "remote.pairing.scanner.failedLink",
        "Couldn't start the camera. Paste the pairing link instead.",
      );
  }
}

function useQrCamera(
  videoRef: RefObject<HTMLVideoElement | null>,
  onText: (text: string) => boolean,
): CameraError | null {
  const [error, setError] = useState<CameraError | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let pass = 0;
    const centre = passCanvas();
    const full = passCanvas();
    const stopCamera = (): void => stream?.getTracks().forEach((track) => track.stop());

    const tick = (): void => {
      const video = videoRef.current;
      if (stopped || !video) return;
      const started = performance.now();
      if (video.readyState >= video.HAVE_ENOUGH_DATA) {
        pass += 1;
        const whole = pass % FULL_FRAME_EVERY === 0;
        const text = decodeFrame(video, whole ? full : centre, !whole);
        if (text && onTextRef.current(text)) {
          stopped = true;
          return;
        }
      }
      const spent = performance.now() - started;
      timer = setTimeout(tick, Math.max(DECODE_INTERVAL_MS, 2 * spent));
    };

    const start = async (): Promise<void> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        const video = videoRef.current;
        if (stopped || !video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        tick();
      } catch (err) {
        // A camera that opened but won't play stays off behind the message.
        stopCamera();
        if (!stopped) setError(cameraError(err));
      }
    };

    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stopCamera();
    };
  }, [videoRef]);
  return error;
}

/**
 * Hints while scanning: a foreign QR for a moment (each sighting extends it,
 * without a render while it stays up), distance advice after a while.
 */
function useScanNotice(): [ScanNotice, () => void] {
  const [notice, setNotice] = useState<ScanNotice>("none");
  const foreignTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => setNotice((n) => (n === "none" ? "hint" : n)), HINT_AFTER_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(foreignTimer.current);
    };
  }, []);
  const sawForeignCode = useCallback(() => {
    setNotice("foreign-code");
    clearTimeout(foreignTimer.current);
    foreignTimer.current = setTimeout(() => setNotice("hint"), FOREIGN_CODE_NOTICE_MS);
  }, []);
  return [notice, sawForeignCode];
}

function noticeText(notice: ScanNotice, t: UiTranslator): string {
  switch (notice) {
    case "none":
      return t("remote.pairing.scanner.looking", "Looking for the code…");
    case "foreign-code":
      return t("remote.pairing.scanner.foreignCode", "That QR code isn't a Cadencr pairing code.");
    case "hint":
      return t(
        "remote.pairing.scanner.hint",
        "Can't find it? Hold the phone 20–30 cm from the screen, with the whole code inside the square.",
      );
  }
}

export function QrPairingScanner({ onCode, onCancel }: QrPairingScannerProps): ReactElement {
  const { t } = useUiTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [notice, sawForeignCode] = useScanNotice();
  const error = useQrCamera(videoRef, (text) => {
    const code = pairingCodeFromScan(text);
    if (!code) {
      sawForeignCode();
      return false;
    }
    onCode(code);
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <video
        ref={videoRef}
        className="absolute inset-0 size-full object-cover"
        playsInline
        muted
        aria-label={t("remote.pairing.scanner.viewfinder", "Camera viewfinder")}
      />

      {/* The square to aim with, the decoder's centre pass. */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="aspect-square w-[70vmin] max-w-80 rounded-3xl border-2 border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.5)]" />
      </div>

      <div className="relative z-10 flex items-center justify-between gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <p className="text-base font-medium drop-shadow">
          {t("remote.pairing.scanner.title", "Scan the code on your computer")}
        </p>
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          onClick={onCancel}
          className="text-white hover:bg-white/15 hover:text-white"
          aria-label={t("remote.pairing.scanner.cancel", "Cancel scan")}
        >
          <X className="size-6" />
        </Button>
      </div>

      <div className="relative z-10 mx-4 mt-auto mb-[max(1.5rem,env(safe-area-inset-bottom))] rounded-2xl bg-black/70 p-4 text-center backdrop-blur">
        {error ? (
          <>
            <p role="alert" className="text-sm text-red-300">
              {cameraErrorMessage(error, t)}
            </p>
            <Button type="button" variant="secondary" className="mt-3 h-11" onClick={onCancel}>
              {t("remote.pairing.scanner.back", "Back")}
            </Button>
          </>
        ) : (
          <p role="status" className="text-sm text-white/90">
            {noticeText(notice, t)}
          </p>
        )}
      </div>
    </div>
  );
}
