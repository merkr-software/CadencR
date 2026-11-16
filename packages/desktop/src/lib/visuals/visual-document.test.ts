import { describe, expect, it } from "vitest";
import type { VisualTheme } from "./live-theme";
import { assembleVisualDocument, requestedLibraries, visualThemeCss } from "./visual-document";

const THEME: VisualTheme = {
  key: "1",
  snapshot: {
    id: "cadencr-dark",
    appearance: "dark",
    tokens: { background: "#101010", "chart-1": "#2db47d" },
  },
  fontSans: '"Inter Variable", sans-serif',
  fontMono: "ui-monospace, monospace",
};

function assemble(html: string, libraries = {}) {
  return assembleVisualDocument({ html, theme: THEME, palette: ["#2db47d"], libraries });
}

describe("requestedLibraries", () => {
  it("lists each bundled library a visual loads, once", () => {
    const html = `<script src="cadencr:d3"></script><script src='cadencr:Chart.js'></script>
      <script src="cadencr:d3"></script><script src="cadencr:three"></script>`;
    expect(requestedLibraries(html)).toEqual(["d3", "chart.js"]);
  });

  it("ignores ordinary scripts", () => {
    expect(requestedLibraries('<script src="https://cdn.example/d3.js"></script>')).toEqual([]);
  });
});

describe("assembleVisualDocument", () => {
  it("inlines a requested library in place of its tag", () => {
    const doc = assemble(
      '<div id="a"></div><script src="cadencr:d3"></script><script>d3.select("#a")</script>',
      {
        d3: "window.d3 = {};",
      },
    );
    expect(doc).toContain("<script>window.d3 = {};</script>");
    expect(doc).not.toContain("cadencr:d3");
    expect(doc.indexOf("window.d3")).toBeLessThan(doc.indexOf('d3.select("#a")'));
  });

  it("themes Chart.js right after loading it", () => {
    const doc = assemble('<script src="cadencr:chart.js"></script>', {
      "chart.js": "window.Chart = {};",
    });
    expect(doc).toMatch(/window\.Chart = \{\};\s*;\(function \(\) \{\s*var Chart = window\.Chart/);
  });

  it("turns an unknown library into a reported script error", () => {
    const doc = assemble('<script src="cadencr:three"></script>');
    expect(doc).toContain(
      'throw new Error("Unknown Cadencr library \\"three\\". Available: d3, chart.js.")',
    );
  });

  it("keeps library source from closing its script element", () => {
    const doc = assemble('<script src="cadencr:d3"></script>', {
      d3: 'var s = "</script><img src=x>";',
    });
    expect(doc).toContain('var s = "<\\/script><img src=x>";');
  });

  it("does not treat $ sequences in library source as replacement patterns", () => {
    const doc = assemble('<script src="cadencr:d3"></script>', { d3: "var a = '$&$1';" });
    expect(doc).toContain("var a = '$&$1';");
  });

  it("puts the bridge before the agent's markup and drops the agent's doctype", () => {
    const doc = assemble("<!DOCTYPE html><p>hello</p>");
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc.indexOf("cadencr-visual:size")).toBeLessThan(doc.indexOf("<p>hello</p>"));
    expect(doc).toContain("window.cadencr = { color: color, palette: palette.slice() }");
    expect(doc).toContain('var palette = ["#2db47d"]');
  });
});

describe("visualThemeCss", () => {
  it("publishes the theme under the app's token names", () => {
    const css = visualThemeCss(THEME);
    expect(css).toContain("color-scheme: dark;");
    expect(css).toContain("--chart-1: #2db47d;");
    expect(css).toContain('--font-sans: "Inter Variable", sans-serif;');
  });

  it("drops token values that could end the rule or the style element", () => {
    const css = visualThemeCss({
      ...THEME,
      snapshot: {
        ...THEME.snapshot,
        tokens: { background: "#101010", border: "red; } </style><script>" },
      },
      fontMono: "x</style>",
    });
    expect(css).toContain("--background: #101010;");
    expect(css).not.toContain("--border");
    expect(css).not.toContain("</style>");
    expect(css).toContain("--font-mono: monospace;");
  });
});
