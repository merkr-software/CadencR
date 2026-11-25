import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
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
  return assembleVisualDocument({
    html,
    theme,
    palette: visualPalette(theme),
    ...assets,
  });
}

type FramePhase = "preparing" | "rendering" | "painted";

/** The loader's step: fetching bundled libraries, then waiting for the first paint. */
function loadingLabel(
  phase: FramePhase,
  libraries: readonly string[],
  t: UiTranslator,
  language: string,
): string {
  if (phase === "rendering")
    return t("conversation.stream.visualFrame.renderingVisual", "Rendering visual…");
  return libraries.length > 0
    ? t("conversation.stream.visualFrame.loading", "Loading {{libraries}}…", {
        libraries: new Intl.ListFormat(language).format(libraries),
      })
    : t("conversation.stream.visualFrame.preparingVisual", "Preparing visual…");
}

interface VisualFrameProps {
  /** Rendered once per mount, like `theme`: the shell takes one document per load. */
  html: string;
  theme: VisualTheme;
  /** `fullscreen` fills its parent viewport and forwards Escape out of the iframe. */
  variant?: "inline" | "fullscreen";
  /** Invoked when Escape is pressed while focus is inside the sandboxed frame. */
  onEscape?: () => void;
}

/**
 * One HTML visual in the service's sandboxed shell: answers the shell's
 * `ready` with the assembled document, then sizes the frame to the height the
 * visual reports and surfaces its script errors.
 */
export function VisualFrame({ html, theme, variant = "inline", onEscape }: VisualFrameProps) {
  const { t, i18n } = useUiTranslation();
  const fullscreen = variant === "fullscreen";
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const [src] = useState(visualFrameSrc);
  const [height, setHeight] = useState(() =>
    fullscreen ? INITIAL_HEIGHT : (rememberedHeight(html) ?? INITIAL_HEIGHT),
  );
  const [phase, setPhase] = useState<FramePhase>("preparing");
  const libraries = useMemo(() => requestedLibraries(html), [html]);
  const [errors, setErrors] = useState<string[]>([]);

  useVisualFrameLifecycle({
    frameRef,
    onEscapeRef,
    fullscreen,
    html,
    libraries,
    theme,
    setPhase,
    setErrors,
    setHeight,
  });

  const painted = phase === "painted";
  // A visual that failed before painting anything collapses to its errors.
  const failed = !painted && errors.length > 0;

  return (
    <>
      <div className={fullscreen && !failed ? "relative min-h-0 flex-1" : "relative"}>
        {!painted && !failed && (
          <VisualLoading overlay label={loadingLabel(phase, libraries, t, i18n.language)} />
        )}
        <iframe
          ref={frameRef}
          src={src}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={t("conversation.stream.visualFrame.agentVisual", "Agent visual")}
          className={
            fullscreen
              ? failed
                ? "block h-0 w-full border-0"
                : "block h-full w-full border-0"
              : "block w-full border-0"
          }
          style={fullscreen ? undefined : { height: failed ? 0 : height }}
        />
      </div>
      {/* Below the visual, clear of the actions floating over its top corner. */}
      {errors.map((message) => (
        <VisualError
          key={message}
          message={t("conversation.stream.visualFrame.visualError", "Visual error: {{message}}", {
            message,
          })}
        />
      ))}
    </>
  );
}

interface VisualFrameLifecycleOptions {
  frameRef: RefObject<HTMLIFrameElement | null>;
  onEscapeRef: RefObject<(() => void) | undefined>;
  fullscreen: boolean;
  html: string;
  libraries: readonly VisualLibrary[];
  theme: VisualTheme;
  setPhase: Dispatch<SetStateAction<FramePhase>>;
  setErrors: Dispatch<SetStateAction<string[]>>;
  setHeight: Dispatch<SetStateAction<number>>;
}

function useVisualFrameLifecycle({
  frameRef,
  onEscapeRef,
  fullscreen,
  html,
  libraries,
  theme,
  setPhase,
  setErrors,
  setHeight,
}: VisualFrameLifecycleOptions) {
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
        addError(
          translateUi(
            "conversation.stream.visualFrame.couldNotPrepareTheVisual",
            "Could not prepare the visual: {{error}}",
            { error: apiErrorMessage(error, String(error)) },
          ),
        ),
    );
    const timeout = window.setTimeout(() => {
      if (!frameReady)
        addError(
          translateUi(
            "conversation.stream.visualFrame.theVisualSandboxDidNotLoadIs",
            "The visual sandbox did not load. Is the Cadencr service reachable?",
          ),
        );
    }, READY_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = parseVisualFrameMessage(event.data);
      if (!message) return;
      if (message.type === VISUAL_MESSAGE.ready) {
        frameReady = true;
        send();
      } else if (message.type === VISUAL_MESSAGE.size) {
        setPhase("painted");
        if (!fullscreen) {
          const next = Math.min(Math.max(message.height, 1), MAX_HEIGHT);
          setHeight(next);
          rememberHeight(html, next);
        }
      } else if (message.type === VISUAL_MESSAGE.escape) {
        onEscapeRef.current?.();
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
  }, [frameRef, onEscapeRef, fullscreen, html, libraries, theme, setErrors, setHeight, setPhase]);
}
