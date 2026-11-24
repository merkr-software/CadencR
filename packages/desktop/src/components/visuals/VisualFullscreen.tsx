import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { lazy, Suspense, useState, type ReactElement } from "react";
import { CodeIcon, EyeIcon, XIcon } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { FullscreenDialog } from "@/components/FullscreenDialog";
import { isLargeCodeBlock } from "@/components/markdown/LargeCodeBlock";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { lazyChunk } from "@/components/lazy/lazy-chunk";
import { VisualLoading } from "@/components/visuals/VisualStatus";
import { cn } from "@/lib/utils";
import { useVisualFullscreenStore, type FullscreenVisual } from "@/stores/visual-fullscreen-store";

// The highlighted source (highlight.js) loads the first time it is shown.
const VisualSource = lazyChunk(() =>
  import("@/components/visuals/VisualChrome").then((module) => module.VisualSource),
);
const VegaLiteChart = lazy(() => import("@/components/visuals/VegaLiteChart"));
const HtmlVisual = lazy(() => import("@/components/visuals/HtmlVisual"));

function visualMeta(t: UiTranslator, kind: FullscreenVisual["kind"]) {
  const meta = {
    "vega-lite": {
      label: t("conversation.stream.visual.chart", "Chart"),
      sourceLanguage: "json",
      loading: t("conversation.stream.visual.loadingChart", "Loading chart renderer…"),
    },
    "cadencr-html": {
      label: t("conversation.stream.visual.visual", "Visual"),
      sourceLanguage: "html",
      loading: t("conversation.stream.visual.loadingHtml", "Loading visual…"),
    },
  } as const;
  return meta[kind];
}

/**
 * The app's single full-screen visualization view (`vega-lite` chart or
 * `cadencr-html` visual), mounted once beside `MermaidFullscreenHost` and
 * `ImageLightboxHost`.
 */
export function VisualFullscreenHost(): ReactElement {
  const { t } = useUiTranslation();
  const visual = useVisualFullscreenStore((s) => s.visual);
  const close = useVisualFullscreenStore((s) => s.close);
  const title = visualMeta(t, visual?.kind ?? "cadencr-html").label;
  return (
    <FullscreenDialog open={visual !== null} onClose={close} title={title}>
      {visual !== null && (
        <VisualFullscreenContent
          key={`${visual.kind}\n${visual.code}`}
          visual={visual}
          onClose={close}
        />
      )}
    </FullscreenDialog>
  );
}

function VisualFullscreenContent({
  visual,
  onClose,
}: {
  visual: FullscreenVisual;
  onClose: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const [showSource, setShowSource] = useState(false);
  const { label, sourceLanguage, loading } = visualMeta(t, visual.kind);
  const toggleLabel = showSource
    ? t("conversation.stream.visualFullscreen.view", "View {{label}}", {
        label: label.toLocaleLowerCase(),
      })
    : t("conversation.stream.visualFullscreen.viewSource", "View source");

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-border px-3">
        <span className="mr-2 text-xs text-muted-foreground">
          {t("conversation.stream.visualFullscreen.escToClose", "Esc to close")}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowSource((current) => !current)}
          title={toggleLabel}
          aria-label={toggleLabel}
        >
          {showSource ? <EyeIcon /> : <CodeIcon />}
        </Button>
        <CopyButton
          text={visual.code}
          label={t("conversation.stream.visualFullscreen.copySource", "Copy source")}
          iconClassName="size-4"
          className="flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
        />
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title={t(
            "conversation.stream.visualFullscreen.exitFullScreenEsc",
            "Exit full screen (Esc)",
          )}
          aria-label={t(
            "conversation.stream.visualFullscreen.exitFullScreenEsc",
            "Exit full screen (Esc)",
          )}
        >
          <XIcon />
        </Button>
      </div>
      {showSource && (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {isLargeCodeBlock(visual.code) ? (
            <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
              <code>{visual.code}</code>
            </pre>
          ) : (
            <LazyBoundary label="source" variant="inline">
              <VisualSource code={visual.code} language={sourceLanguage} />
            </LazyBoundary>
          )}
        </div>
      )}
      {/* Keep the rendered visual mounted while viewing source so toggling back
          neither recompiles Vega nor reloads the sandboxed HTML iframe. */}
      <div className={cn("min-h-0 flex-1 flex-col p-6", showSource ? "hidden" : "flex")}>
        <Suspense fallback={<VisualLoading label={loading} />}>
          {visual.kind === "vega-lite" ? (
            <VegaLiteChart code={visual.code} variant="fullscreen" />
          ) : (
            <HtmlVisual code={visual.code} variant="fullscreen" onEscape={onClose} />
          )}
        </Suspense>
      </div>
    </>
  );
}
