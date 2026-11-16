import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChartColumnIcon } from "lucide-react";
import type { View } from "vega";
import type { TopLevelSpec } from "vega-lite";
import { VisualChrome, VisualSourceBlock } from "@/components/visuals/VisualChrome";
import { VisualError, VisualLoading } from "@/components/visuals/VisualStatus";
import { useElementWidth } from "@/hooks/useElementSize";
import { apiErrorMessage } from "@/lib/api-errors";
import { rememberedHeight, rememberHeight } from "@/lib/visuals/height-cache";
import { useVisualTheme } from "@/lib/visuals/live-theme";
import {
  fitsContainerWidth,
  parseVegaLiteSpec,
  renderVegaLite,
  resizeToContainer,
} from "@/lib/visuals/vega-chart";
import { vegaThemeConfig } from "@/lib/visuals/vega-theme";

type ChartState =
  | { status: "rendering" }
  | { status: "ready" }
  | { status: "error"; message: string };

function failed(error: unknown): ChartState {
  return { status: "error", message: apiErrorMessage(error, String(error)) };
}

/**
 * The chart itself, drawn natively (SVG, no frame) in the live theme and
 * redrawn when the theme changes. Fills the conversation width and follows
 * pane resizes once they settle, unless the spec sets its own width.
 */
function ChartCanvas({ code, spec }: { code: string; spec: TopLevelSpec }) {
  const theme = useVisualTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<{ view: View; width: number } | null>(null);
  const width = useElementWidth(containerRef);
  const [state, setState] = useState<ChartState>({ status: "rendering" });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    setState({ status: "rendering" });
    renderVegaLite(container, spec, vegaThemeConfig(theme)).then(
      (view) => {
        if (cancelled) {
          view.finalize();
          return;
        }
        viewRef.current = { view, width: container.clientWidth };
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
  }, [spec, theme]);

  useEffect(() => {
    const rendered = viewRef.current;
    if (!rendered || width === null || width === rendered.width || !fitsContainerWidth(spec)) {
      return;
    }
    rendered.width = width;
    let cancelled = false;
    resizeToContainer(rendered.view, spec, width).catch((error: unknown) => {
      if (!cancelled) setState(failed(error));
    });
    return () => {
      cancelled = true;
    };
  }, [spec, width, state.status]);

  useLayoutEffect(() => {
    if (state.status === "ready" && containerRef.current) {
      rememberHeight(code, containerRef.current.offsetHeight);
    }
  }, [code, state.status]);

  const rendering = state.status === "rendering";
  return (
    <>
      <div
        className={rendering ? "relative min-h-24" : "relative"}
        style={rendering ? { minHeight: rememberedHeight(code) } : undefined}
      >
        {rendering && <VisualLoading overlay label="Rendering chart…" />}
        <div ref={containerRef} className="w-full overflow-x-auto" />
      </div>
      {state.status === "error" && (
        <VisualError message={`Could not render chart: ${state.message}`} />
      )}
    </>
  );
}

interface VegaLiteChartProps {
  code: string;
}

const CHART_FENCE = {
  label: "Chart",
  icon: <ChartColumnIcon className="size-3" />,
  sourceLanguage: "json",
};

/** A ` ```vega-lite ` fence: the chart, with its JSON one click away. */
const VegaLiteChart = memo(function VegaLiteChart({ code }: VegaLiteChartProps) {
  const parsed = useMemo(() => parseVegaLiteSpec(code), [code]);

  if (!parsed.ok) {
    return (
      <>
        <VisualError message={`Could not render chart: ${parsed.error}`} />
        <VisualSourceBlock {...CHART_FENCE} code={code} />
      </>
    );
  }
  return (
    <VisualChrome {...CHART_FENCE} code={code}>
      <ChartCanvas code={code} spec={parsed.spec} />
    </VisualChrome>
  );
});

export default VegaLiteChart;
