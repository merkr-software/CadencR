import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { Markdown } from "./Markdown";
import { __markdownCacheTestHelpers as cache } from "./markdown/markdown-tree-cache";

// The real renderers pull in Vega and the sandbox frame; only the dispatch is under test.
vi.mock("@/components/visuals/VegaLiteChart", () => ({
  default: ({ code }: { code: string }) => <div data-testid="vega-lite-chart">{code}</div>,
}));
vi.mock("@/components/visuals/HtmlVisual", () => ({
  default: ({ code }: { code: string }) => <div data-testid="html-visual">{code}</div>,
}));

const CHART = '```vega-lite\n{"mark": "bar"}\n```';
const HTML = '```cadencr-html\n<div class="card">Hi</div>\n```';
const HTML_EXAMPLE = '```html\n<div class="card">Hi</div>\n```';

describe("Markdown visual fences", () => {
  beforeEach(() => cache.clear());

  it("renders a settled vega-lite fence as a chart", async () => {
    render(<Markdown content={CHART} cacheKey="chart" />);
    expect(await screen.findByTestId("vega-lite-chart")).toHaveTextContent('{"mark": "bar"}');
  });

  it("renders a settled cadencr-html fence as a visual", async () => {
    render(<Markdown content={HTML} cacheKey="visual" />);
    expect(await screen.findByTestId("html-visual")).toHaveTextContent(
      '<div class="card">Hi</div>',
    );
  });

  it("holds both places with a writing loader while the reply streams", () => {
    render(<Markdown content={`${CHART}\n\n${HTML}`} isStreaming />);
    expect(screen.queryByTestId("vega-lite-chart")).not.toBeInTheDocument();
    expect(screen.queryByTestId("html-visual")).not.toBeInTheDocument();
    expect(screen.getByText("Writing chart…")).toBeInTheDocument();
    expect(screen.getByText("Writing visual…")).toBeInTheDocument();
    expect(screen.queryByText('{"mark": "bar"}')).not.toBeInTheDocument();
  });

  it("counts the lines written so far", () => {
    render(<Markdown content={"```cadencr-html\n<div>\n  <p>Hi</p>"} isStreaming />);
    expect(screen.getByText("· 2 lines")).toBeInTheDocument();
  });

  it("shows a cut-off fence of a settled reply as its code", () => {
    render(<Markdown content={'```vega-lite\n{"mark": "bar"}'} cacheKey="cut-off" />);
    expect(screen.queryByTestId("vega-lite-chart")).not.toBeInTheDocument();
    expect(screen.queryByText("Writing chart…")).not.toBeInTheDocument();
    expect(screen.getByText("vega-lite")).toBeInTheDocument();
  });

  it("never renders a plain html example", () => {
    render(<Markdown content={HTML_EXAMPLE} cacheKey="example" />);
    expect(screen.queryByTestId("html-visual")).not.toBeInTheDocument();
    expect(screen.getByText("html")).toBeInTheDocument();
  });
});
