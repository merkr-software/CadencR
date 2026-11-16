import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { VisualError, VisualLoading } from "@/components/visuals/VisualStatus";
import { apiErrorMessage } from "@/lib/api-errors";
import { rememberedHeight, rememberHeight } from "@/lib/visuals/height-cache";
import type { VisualTheme } from "@/lib/visuals/live-theme";
import { visualPalette } from "@/lib/visuals/theme-colors";
import { loadVisualAssets } from "@/lib/visuals/visual-assets";
import {
  assembleVisualDocument,
  requestedLibraries,
  type VisualLibrary,
} from "@/lib/visuals/visual-document";
import {
  parseVisualFrameMessage,
  VISUAL_MESSAGE,
  visualFrameSrc,
} from "@/lib/visuals/visual-protocol";

/** Placeholder height before the visual reports its own. */
const INITIAL_HEIGHT = 96;
/** Taller visuals scroll inside their frame instead of flooding the transcript. */
const MAX_HEIGHT = 1600;
/** Distinct errors kept: a visual throwing in a loop must not flood the strip. */
const MAX_ERRORS = 3;
/** How long the shell may take to answer before the frame counts as broken. */
const READY_TIMEOUT_MS = 10_000;

async function buildDocument(
  html: string,
  libraries: readonly VisualLibrary[],
  theme: VisualTheme,
): Promise<string> {
  const assets = await loadVisualAssets(libraries);
  return assembleVisualDocument({ html, theme, palette: visualPalette(theme), ...assets });
}

type FramePhase = "preparing" | "rendering" | "painted";

/** The loader's step: fetching bundled libraries, then waiting for the first paint. */
function loadingLabel(phase: FramePhase, libraries: readonly string[]): string {
  if (phase === "rendering") return "Rendering visual…";
  return libraries.length > 0 ? `Loading ${libraries.join(" and ")}…` : "Preparing visual…";
}

interface VisualFrameProps {
  /** Rendered once per mount, like `theme`: the shell takes one document per load. */
  html: string;
  theme: VisualTheme;
}

/**
 * One HTML visual in the service's sandboxed shell: answers the shell's
 * `ready` with the assembled document, then sizes the frame to the height the
 * visual reports and surfaces its script errors.
 */
export function VisualFrame({ html, theme }: VisualFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(visualFrameSrc);
  const [height, setHeight] = useState(() => rememberedHeight(html) ?? INITIAL_HEIGHT);
  const [phase, setPhase] = useState<FramePhase>("preparing");
  const libraries = useMemo(() => requestedLibraries(html), [html]);
  const [errors, setErrors] = useState<string[]>([]);

  // Layout effect: the listener must exist before the frame can load and post `ready`.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    let frameReady = false;
    let source: string | null = null;
    const addError = (message: string) => {
      if (cancelled) return;
      setErrors((current) =>
        current.includes(message) || current.length >= MAX_ERRORS ? current : [...current, message],
      );
    };
    // The document is built while the shell loads; whichever finishes last sends it.
    const send = () => {
      if (cancelled || !frameReady || source === null) return;
      frame.contentWindow?.postMessage({ type: VISUAL_MESSAGE.render, html: source }, "*");
      setPhase((current) => (current === "painted" ? current : "rendering"));
    };
    buildDocument(html, libraries, theme).then(
      (built) => {
        source = built;
        send();
      },
      (error: unknown) =>
        addError(`Could not prepare the visual: ${apiErrorMessage(error, String(error))}`),
    );
    const timeout = window.setTimeout(() => {
      if (!frameReady)
        addError("The visual sandbox did not load. Is the Cadencr service reachable?");
    }, READY_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = parseVisualFrameMessage(event.data);
      if (!message) return;
      if (message.type === VISUAL_MESSAGE.ready) {
        frameReady = true;
        send();
      } else if (message.type === VISUAL_MESSAGE.size) {
        const next = Math.min(Math.max(message.height, 1), MAX_HEIGHT);
        setHeight(next);
        setPhase("painted");
        rememberHeight(html, next);
      } else {
        addError(message.message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [html, libraries, theme]);

  const painted = phase === "painted";
  // A visual that failed before painting anything collapses to its errors.
  const failed = !painted && errors.length > 0;

  return (
    <>
      <div className="relative">
        {!painted && !failed && <VisualLoading overlay label={loadingLabel(phase, libraries)} />}
        <iframe
          ref={frameRef}
          src={src}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title="Agent visual"
          className="block w-full border-0"
          style={{ height: failed ? 0 : height }}
        />
      </div>
      {/* Below the visual, clear of the actions floating over its top corner. */}
      {errors.map((message) => (
        <VisualError key={message} message={`Visual error: ${message}`} />
      ))}
    </>
  );
}
