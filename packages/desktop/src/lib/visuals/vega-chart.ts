import { translateUi } from "@/lib/i18n/ui";
import { loader as vegaLoader, logger as vegaLogger, parse, View, Warn } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile, type Config, type TopLevelSpec } from "vega-lite";

import { apiErrorMessage } from "@/lib/api-errors";

/** Narrower than this, axes and legend no longer fit. */
const MIN_CHART_WIDTH = 120;
/** Shorter than this, a fullscreen chart loses legibility. */
const MIN_CHART_HEIGHT = 200;

export type SpecParseError = { kind: "invalidJson"; detail: string } | { kind: "expectedObject" };

export type SpecParseResult =
  | { ok: true; spec: TopLevelSpec }
  | { ok: false; error: SpecParseError };

/** The fence body as a Vega-Lite spec object, or why it is not one. */
export function parseVegaLiteSpec(code: string): SpecParseResult {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch (error) {
    return {
      ok: false,
      error: { kind: "invalidJson", detail: apiErrorMessage(error, String(error)) },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: { kind: "expectedObject" } };
  }
  // Compilation (and its schema errors) happens at render time.
  return { ok: true, spec: value as TopLevelSpec };
}

function isSingleOrLayered(spec: TopLevelSpec): boolean {
  return "mark" in spec || "layer" in spec;
}

/**
 * A single or layered view without its own `width` fills the conversation:
 * the measured width, with autosize fitting axes and legend inside it.
 * `"container"` would follow window resizes only, not a pane resize.
 */
export function fitsContainerWidth(spec: TopLevelSpec): boolean {
  return !("width" in spec) && isSingleOrLayered(spec);
}

/** A single or layered view without its own `height` can also fill fullscreen height. */
export function fitsContainerHeight(spec: TopLevelSpec): boolean {
  return !("height" in spec) && isSingleOrLayered(spec);
}

function withSize(spec: TopLevelSpec, width: number, height: number | undefined): TopLevelSpec {
  const fitW = fitsContainerWidth(spec);
  const fitH = height !== undefined && fitsContainerHeight(spec);
  if (!fitW && !fitH) return spec;
  return {
    ...spec,
    ...(fitW && { width: Math.max(width, MIN_CHART_WIDTH) }),
    ...(fitH && { height: Math.max(height, MIN_CHART_HEIGHT) }),
    autosize: { type: fitW && fitH ? "fit" : fitW ? "fit-x" : "fit-y", contains: "padding" },
  } as TopLevelSpec;
}

/**
 * A loader that refuses every URL: data, images and link targets alike. Vega
 * treats a failed load as a mere warning that leaves an empty chart, so each
 * refusal is also reported through `onRefuse`.
 */
function offlineLoader(onRefuse: (message: string) => void) {
  const loader = vegaLoader();
  let message: string | undefined;
  const refuse = () => {
    message ??= translateUi(
      "conversation.stream.vegaChart.chartsInTheConversationCannotLoadExternal",
      "Charts in the conversation cannot load external resources; inline the data in data.values.",
    );
    onRefuse(message);
    return Promise.reject(new Error(message));
  };
  loader.load = refuse;
  loader.sanitize = refuse;
  return loader;
}

/**
 * Compile and render `spec` as SVG into `container`. Vega reports dataflow
 * errors through its logger rather than by rejecting, so they are collected
 * (with refused loads) and rethrown. Expressions run through the AST
 * interpreter: the renderer CSP forbids the `Function` code generation Vega
 * uses by default.
 */
export async function renderVegaLite(
  container: HTMLElement,
  spec: TopLevelSpec,
  config: Config,
  options?: { fitHeight?: boolean },
): Promise<View> {
  const errors: string[] = [];
  const logger = vegaLogger(Warn, undefined, (method, _level, args) => {
    if (method === "error")
      errors.push(args.map((arg) => apiErrorMessage(arg, String(arg))).join(" "));
  });
  const targetHeight = options?.fitHeight ? container.clientHeight : undefined;
  const { spec: vegaSpec } = compile(withSize(spec, container.clientWidth, targetHeight), {
    config,
    logger,
  });
  const view = new View(parse(vegaSpec, undefined, { ast: true }), {
    expr: expressionInterpreter,
    loader: offlineLoader((message) => errors.push(message)),
    logger,
    renderer: "svg",
    container,
    hover: true,
  });
  await view.runAsync();
  if (errors.length > 0) {
    view.finalize();
    throw new Error(errors[0]);
  }
  return view;
}

/** Follow the container's size (pane or fullscreen resizes) when the chart fills it. */
export async function resizeToContainer(
  view: View,
  spec: TopLevelSpec,
  width: number,
  height?: number,
): Promise<void> {
  const fitW = fitsContainerWidth(spec);
  const fitH = height !== undefined && height > 0 && fitsContainerHeight(spec);
  if (!fitW && !fitH) return;
  if (fitW) view.width(Math.max(width, MIN_CHART_WIDTH));
  if (fitH) view.height(Math.max(height, MIN_CHART_HEIGHT));
  await view.runAsync();
}
