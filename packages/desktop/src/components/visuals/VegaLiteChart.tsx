import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChartColumnIcon } from "lucide-react";
import type { View } from "vega";
import type { TopLevelSpec } from "vega-lite";
import { VisualChrome, VisualSourceBlock } from "@/components/visuals/VisualChrome";
import { VisualError, VisualLoading } from "@/components/visuals/VisualStatus";
import { useElementSize } from "@/hooks/useElementSize";
import { apiErrorMessage } from "@/lib/api-errors";
import { rememberedHeight, rememberHeight } from "@/lib/visuals/height-cache";
import { useVisualTheme } from "@/lib/visuals/live-theme";
import {
  fitsContainerHeight,
  fitsContainerWidth,
  parseVegaLiteSpec,
  renderVegaLite,
  resizeToContainer,
  type SpecParseError,
} from "@/lib/visuals/vega-chart";
import { vegaThemeConfig } from "@/lib/visuals/vega-theme";
import { openVisualFullscreen } from "@/stores/visual-fullscreen-store";

type ChartState =
  | { status: "rendering" }
  | { status: "ready" }
  | { status: "error"; message: string };

function failed(error: unknown): ChartState {
  return { status: "error", message: apiErrorMessage(error, String(error)) };
}

/**
 * The chart itself, drawn natively (SVG, no frame) in the live theme and
 * redrawn when the theme changes. Fills the conversation width (and viewport
 * height in fullscreen) and follows resizes once they settle, unless the spec
 * sets its own dimensions.
 */
function ChartError({ message }: { message: string }) {
  const { t } = useUiTranslation();
  return (
    <VisualError
      message={t(
        "conversation.stream.vegaLiteChart.couldNotRenderChart",
        "Could not render chart: {{error}}",
        { error: message },
      )}
    />
  );
}

function ChartLoading() {
  const { t } = useUiTranslation();
  return (
    <VisualLoading
      overlay
      label={t("conversation.stream.vegaLiteChart.renderingChart", "Rendering chart…")}
    />
  );
}

function ChartCanvas({
  code,
  spec,
  variant = "inline",
}: {
  code: string;
  spec: TopLevelSpec;
  variant?: "inline" | "fullscreen";
}) {
  const fullscreen = variant === "fullscreen";
  const theme = useVisualTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<{ view: View; width: number; height: number } | null>(null);
  const size = useElementSize(containerRef);
  const width = size?.width ?? null;
  const height = fullscreen ? (size?.height ?? null) : null;
  const [state, setState] = useState<ChartState>({ status: "rendering" });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setState({ status: "rendering" });
    renderVegaLite(container, spec, vegaThemeConfig(theme), {
      fitHeight: fullscreen,
    }).then(
      (view) => {
        if (cancelled) {
          view.finalize();
          return;
        }
        viewRef.current = {
          view,
          width: container.clientWidth,
          height: container.clientHeight,
        };
        setState({ status: "ready" });
      },
      (error: unknown) => {
        if (!cancelled) setState(failed(error));
      },
    );
    return () => {
      cancelled = true;
      viewRef.current?.view.finalize();
      viewRef.current = null;
      container.replaceChildren();
    };
  }, [fullscreen, spec, theme]);

  useEffect(() => {
    const rendered = viewRef.current;
    if (!rendered || width === null) return;
    const widthChanged = fitsContainerWidth(spec) && width !== rendered.width;
    const heightChanged =
      fullscreen &&
      height !== null &&
      height > 0 &&
      fitsContainerHeight(spec) &&
      height !== rendered.height;
    if (!widthChanged && !heightChanged) return;
    rendered.width = width;
    if (height !== null) rendered.height = height;
    let cancelled = false;
    resizeToContainer(rendered.view, spec, width, height ?? undefined).catch((error: unknown) => {
      if (!cancelled) setState(failed(error));
    });
    return () => {
      cancelled = true;
    };
  }, [fullscreen, spec, width, height, state.status]);

  useLayoutEffect(() => {
    if (!fullscreen && state.status === "ready" && containerRef.current) {
      rememberHeight(code, containerRef.current.offsetHeight);
    }
  }, [code, fullscreen, state.status]);

  const rendering = state.status === "rendering";
  return (
    <>
      <div
        className={
          fullscreen ? "relative min-h-0 flex-1" : rendering ? "relative min-h-24" : "relative"
        }
        style={!fullscreen && rendering ? { minHeight: rememberedHeight(code) } : undefined}
      >
        {rendering && <ChartLoading />}
        <div
          ref={containerRef}
          className={
            fullscreen
              ? "flex h-full w-full overflow-auto [&_svg]:m-auto"
              : "w-full overflow-x-auto"
          }
        />
      </div>
      {state.status === "error" && <ChartError message={state.message} />}
    </>
  );
}

interface VegaLiteChartProps {
  code: string;
  variant?: "inline" | "fullscreen";
}

const CHART_FENCE = {
  icon: <ChartColumnIcon className="size-3" />,
  sourceLanguage: "json",
};

function describeParseError(error: SpecParseError, t: UiTranslator): string {
  return error.kind === "invalidJson"
    ? t("conversation.stream.vegaChart.invalidJson", "Invalid JSON: {{error}}", {
        error: error.detail,
      })
    : t(
        "conversation.stream.vegaChart.aVegaLiteSpecMustBeAJson",
        "A Vega-Lite spec must be a JSON object.",
      );
}

/** A ` ```vega-lite ` fence: the chart, with its JSON one click away. */
const VegaLiteChart = memo(function VegaLiteChart({
  code,
  variant = "inline",
}: VegaLiteChartProps) {
  const { t } = useUiTranslation();
  const parsed = useMemo(() => parseVegaLiteSpec(code), [code]);
  const expand = useCallback(() => openVisualFullscreen({ kind: "vega-lite", code }), [code]);

  const label = t("conversation.stream.visual.chart", "Chart");
  if (!parsed.ok) {
    const message = describeParseError(parsed.error, t);
    if (variant === "fullscreen") {
      return <ChartError message={message} />;
    }
    return (
      <>
        <ChartError message={message} />
        <VisualSourceBlock {...CHART_FENCE} label={label} code={code} />
      </>
    );
  }
  if (variant === "fullscreen") {
    return <ChartCanvas code={code} spec={parsed.spec} variant="fullscreen" />;
  }
  return (
    <VisualChrome {...CHART_FENCE} label={label} code={code} onExpand={expand}>
      <ChartCanvas code={code} spec={parsed.spec} />
    </VisualChrome>
  );
});

export default VegaLiteChart;
