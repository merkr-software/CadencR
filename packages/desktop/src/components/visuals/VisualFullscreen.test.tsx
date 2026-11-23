// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";
import HtmlVisual from "@/components/visuals/HtmlVisual";
import VegaLiteChart from "@/components/visuals/VegaLiteChart";
import { VisualFullscreenHost } from "@/components/visuals/VisualFullscreen";
import { useVisualFullscreenStore } from "@/stores/visual-fullscreen-store";

vi.mock("@/lib/browser-suppression", () => ({
  useSuppressBrowserView: () => undefined,
}));
vi.mock("@/lib/visuals/visual-assets", () => ({
  loadVisualAssets: vi.fn(async () => ({
    fontDataUrl: "data:font/woff2;base64,AA==",
    libraries: {},
  })),
}));
vi.mock("@/lib/visuals/visual-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/visuals/visual-protocol")>()),
  visualFrameSrc: () => "about:blank",
}));

const BAR_SPEC = JSON.stringify({
  title: "Latency",
  data: {
    values: [
      { step: "a", ms: 12 },
      { step: "b", ms: 24 },
    ],
  },
  mark: "bar",
  encoding: {
    x: { field: "step", type: "nominal" },
    y: { field: "ms", type: "quantitative" },
  },
});

const HTML_VISUAL = '<div class="card"><h1>Summary</h1></div>';

afterEach(() => {
  act(() => useVisualFullscreenStore.setState({ visual: null }));
});

describe("VisualFullscreenHost", () => {
  it("renders nothing until a visualization is opened", () => {
    render(<VisualFullscreenHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a Vega-Lite chart full screen, keeps it open when the inline row unmounts, and closes on Escape", async () => {
    const { rerender } = render(
      <>
        <VegaLiteChart code={BAR_SPEC} />
        <VisualFullscreenHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByText("Esc to close")).toBeInTheDocument();
    expect(screen.getByTitle("Exit full screen (Esc)")).toBeInTheDocument();

    await waitFor(() => expect(dialog.querySelector("svg.marks")).not.toBeNull());
    const chartSvg = dialog.querySelector("svg.marks");

    // Simulate Virtuoso recycling the inline message row while fullscreen stays mounted.
    rerender(
      <>
        {null}
        <VisualFullscreenHost />
      </>,
    );
    expect(screen.getByRole("dialog").querySelector("svg.marks")).toBe(chartSvg);

    // Toggling source view inside fullscreen swaps to code and back without rebuilding the chart.
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    expect(screen.getByRole("dialog").querySelector("pre")).toHaveTextContent('"Latency"');
    fireEvent.click(screen.getByRole("button", { name: "View chart" }));
    expect(screen.getByRole("dialog").querySelector("svg.marks")).toBe(chartSvg);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("skips synchronous syntax highlighting for large fullscreen source payloads", async () => {
    const largeHtml = Array.from({ length: 500 }, (_, i) => `<p>${i}</p>`).join("\n");
    render(
      <>
        <HtmlVisual code={largeHtml} />
        <VisualFullscreenHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    const code = dialog.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code).not.toHaveClass("hljs");
    expect(code?.textContent).toContain("<p>499</p>");
  });

  it("opens an HTML visual full screen and closes on both close button and iframe Escape", async () => {
    render(
      <>
        <HtmlVisual code={HTML_VISUAL} />
        <VisualFullscreenHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.querySelectorAll('iframe[title="Agent visual"]')).toHaveLength(1),
    );
    const frame = dialog.querySelector('iframe[title="Agent visual"]');
    if (!frame) throw new Error("fullscreen iframe missing");

    const fakeWindow = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", {
      value: fakeWindow,
      configurable: true,
    });
    act(() => {
      const event = new MessageEvent("message", {
        data: { type: "cadencr-visual:escape" },
      });
      Object.defineProperty(event, "source", { value: fakeWindow });
      window.dispatchEvent(event);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Reopen and close via the header button.
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    fireEvent.click(await screen.findByTitle("Exit full screen (Esc)"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
