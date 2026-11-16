import { loader as vegaLoader, logger as vegaLogger, parse, View, Warn } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile, type Config, type TopLevelSpec } from "vega-lite";

import { apiErrorMessage } from "@/lib/api-errors";

/** Narrower than this, axes and legend no longer fit. */
const MIN_CHART_WIDTH = 120;

const EXTERNAL_DATA_ERROR =
  "Charts in the conversation cannot load external resources; inline the data in data.values.";

export type SpecParseResult = { ok: true; spec: TopLevelSpec } | { ok: false; error: string };

/** The fence body as a Vega-Lite spec object, or why it is not one. */
export function parseVegaLiteSpec(code: string): SpecParseResult {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${apiErrorMessage(error, String(error))}`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "A Vega-Lite spec must be a JSON object." };
  }
  // Compilation (and its schema errors) happens at render time.
  return { ok: true, spec: value as TopLevelSpec };
}

/**
 * A single or layered view without its own `width` fills the conversation:
 * the measured width, with autosize fitting axes and legend inside it.
 * `"container"` would follow window resizes only, not a pane resize.
 */
export function fitsContainerWidth(spec: TopLevelSpec): boolean {
  return !("width" in spec) && ("mark" in spec || "layer" in spec);
}

function withWidth(spec: TopLevelSpec, width: number): TopLevelSpec {
  if (!fitsContainerWidth(spec)) return spec;
  return {
    ...spec,
    width: Math.max(width, MIN_CHART_WIDTH),
    autosize: { type: "fit-x", contains: "padding" },
  } as TopLevelSpec;
}

/**
 * A loader that refuses every URL: data, images and link targets alike. Vega
 * treats a failed load as a mere warning that leaves an empty chart, so each
 * refusal is also reported through `onRefuse`.
 */
function offlineLoader(onRefuse: () => void) {
  const loader = vegaLoader();
  const refuse = () => {
    onRefuse();
    return Promise.reject(new Error(EXTERNAL_DATA_ERROR));
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
): Promise<View> {
  const errors: string[] = [];
  const logger = vegaLogger(Warn, undefined, (method, _level, args) => {
    if (method === "error")
      errors.push(args.map((arg) => apiErrorMessage(arg, String(arg))).join(" "));
  });
  const { spec: vegaSpec } = compile(withWidth(spec, container.clientWidth), { config, logger });
  const view = new View(parse(vegaSpec, undefined, { ast: true }), {
    expr: expressionInterpreter,
    loader: offlineLoader(() => errors.push(EXTERNAL_DATA_ERROR)),
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

/** Follow the container's width (pane resizes) when the chart fills it. */
export async function resizeToContainer(
  view: View,
  spec: TopLevelSpec,
  width: number,
): Promise<void> {
  if (!fitsContainerWidth(spec)) return;
  await view.width(Math.max(width, MIN_CHART_WIDTH)).runAsync();
}
