import { MAX_VISUAL_ERROR_LENGTH, VISUAL_MESSAGE } from "./visual-protocol";

/**
 * Scripts written into every HTML visual, as source text: they run inside the
 * sandboxed frame, never in the app. Kept to ES5 so nothing here depends on
 * the renderer's build pipeline.
 */

/**
 * Runs first in the visual's `<head>`: reports the content height (the frame
 * grows to fit) and every script error or blocked resource to the renderer,
 * and exposes `window.cadencr` — `color(name)` resolves a theme variable for
 * canvas libraries, `palette` holds the categorical series colors.
 */
export function visualBridgeScript(palette: readonly string[]): string {
  return `(function () {
  "use strict";
  var palette = ${JSON.stringify(palette)};
  function post(message) { window.parent.postMessage(message, "*"); }
  function fail(message) {
    post({ type: "${VISUAL_MESSAGE.error}", message: String(message).slice(0, ${MAX_VISUAL_ERROR_LENGTH}) });
  }
  window.addEventListener("error", function (event) { fail(event.message || "Script error"); });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    fail((reason && reason.message) || reason || "Unhandled promise rejection");
  });
  document.addEventListener("securitypolicyviolation", function (event) {
    fail("Blocked " + event.effectiveDirective + " " + (event.blockedURI || "inline") +
      ": visuals run offline, so network requests and remote resources are blocked");
  });
  var canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  var context = canvas.getContext("2d", { willReadFrequently: true });
  function color(name) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!value || !context) return value;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    var d = context.getImageData(0, 0, 1, 1).data;
    if (d[3] === 255) return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")";
    return "rgba(" + d[0] + ", " + d[1] + ", " + d[2] + ", " + (d[3] / 255).toFixed(3) + ")";
  }
  window.cadencr = { color: color, palette: palette.slice() };
  var lastHeight = -1;
  function report() {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    post({ type: "${VISUAL_MESSAGE.size}", height: height });
  }
  new ResizeObserver(report).observe(document.documentElement);
  window.addEventListener("load", report);
})();`;
}

/**
 * Appended to the bundled Chart.js: theme defaults (Inter, muted labels,
 * hairline grid) and the categorical palette for datasets without colors,
 * replacing Chart.js's own default palette.
 */
export const CHART_JS_THEME_SCRIPT = `
;(function () {
  var Chart = window.Chart, cadencr = window.cadencr;
  if (!Chart || !cadencr) return;
  var defaults = Chart.defaults, palette = cadencr.palette;
  defaults.color = cadencr.color("--muted-foreground");
  defaults.borderColor = cadencr.color("--border");
  defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");
  defaults.font.size = 11;
  if (defaults.plugins && defaults.plugins.colors) defaults.plugins.colors.enabled = false;
  var radial = { pie: true, doughnut: true, polarArea: true };
  Chart.register({
    id: "cadencrPalette",
    beforeUpdate: function (chart) {
      var type = chart.config.type;
      chart.data.datasets.forEach(function (dataset, index) {
        var tone = palette[index % palette.length];
        if (radial[type]) {
          if (dataset.backgroundColor === undefined) {
            dataset.backgroundColor = dataset.data.map(function (_, slice) {
              return palette[slice % palette.length];
            });
          }
          if (dataset.borderWidth === undefined) dataset.borderWidth = 0;
          return;
        }
        if (dataset.backgroundColor === undefined) dataset.backgroundColor = tone;
        if (dataset.borderColor === undefined) dataset.borderColor = tone;
      });
    }
  });
})();`;
