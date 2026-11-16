// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test-utils";
import MermaidDiagram from "./MermaidDiagram";
import { MermaidFullscreenHost } from "./MermaidFullscreen";
import { useMermaidFullscreenStore } from "@/stores/mermaid-fullscreen-store";

// Stub the theme hook so the component does not pull in the settings API.
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: { appearance: "light" } }),
}));

const parse = vi.fn();
const renderFn = vi.fn();
const initialize = vi.fn();

// The fallback path dynamically imports "mermaid"; mock the module wholesale.
vi.mock("mermaid", () => ({
  default: {
    initialize,
    parse,
    render: renderFn,
    mermaidAPI: { defaultConfig: { secure: ["securityLevel"] } },
  },
}));

// beautiful-mermaid draws flowcharts; mermaid only sees the kinds it cannot.
const FLOWCHART = "graph TD\n  Start-->Finish";
const PIE = 'pie\n  "a" : 1\n  "b" : 2';
const INVALID_PIE = "pie\n  )(*&";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    parse.mockReset();
    renderFn.mockReset();
    initialize.mockReset();
    useMermaidFullscreenStore.setState({ svg: null });
  });

  it("draws supported kinds with beautiful-mermaid, without loading mermaid", () => {
    const { container } = render(<MermaidDiagram code={FLOWCHART} />);

    expect(container.querySelector("svg[data-beautiful-mermaid]")).toBeInTheDocument();
    expect(parse).not.toHaveBeenCalled();
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("falls back to mermaid for other kinds, gating render() on parse()", async () => {
    parse.mockResolvedValue({ diagramType: "pie" });
    renderFn.mockResolvedValue({ svg: "<svg data-testid='ok'></svg>" });

    render(<MermaidDiagram code={PIE} />);

    await waitFor(() => expect(renderFn).toHaveBeenCalledWith(expect.any(String), PIE));
    expect(parse).toHaveBeenCalledWith(PIE);
    expect(await screen.findByTestId("ok")).toBeInTheDocument();
  });

  it("shows a cached fallback render on remount without a loading flash", async () => {
    const code = 'pie\n  "cached" : 1';
    parse.mockResolvedValue({ diagramType: "pie" });
    renderFn.mockResolvedValue({ svg: "<svg data-testid='cached-pie'></svg>" });
    const first = render(<MermaidDiagram code={code} />);
    await screen.findByTestId("cached-pie");
    first.unmount();

    render(<MermaidDiagram code={code} />);
    expect(screen.getByTestId("cached-pie")).toBeInTheDocument();
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
    expect(renderFn).toHaveBeenCalledOnce();
  });

  it("never calls render() when the fallback source is invalid", async () => {
    // parse() rejects on invalid syntax (mermaid's documented behaviour).
    parse.mockRejectedValue(new Error("Parse error on line 2"));

    render(<MermaidDiagram code={INVALID_PIE} />);

    await waitFor(() => expect(parse).toHaveBeenCalledWith(INVALID_PIE));
    // The DOM-leaking render() path must never be reached for invalid output.
    expect(renderFn).not.toHaveBeenCalled();
    // The error is surfaced to the user with the parser message.
    expect(await screen.findByText(/Could not render diagram/)).toBeInTheDocument();
  });

  it("opens the diagram full screen under its own ids and closes it on Escape", async () => {
    const { container } = render(
      <>
        <MermaidDiagram code={FLOWCHART} />
        <MermaidFullscreenHost />
      </>,
    );

    fireEvent.click(screen.getByTitle("Full screen"));
    const dialog = await screen.findByRole("dialog");
    const inlineSvg = container.querySelector("svg[data-beautiful-mermaid]")?.outerHTML ?? "";
    const fullscreenSvg = dialog.querySelector("svg[data-beautiful-mermaid]")?.outerHTML ?? "";
    expect(fullscreenSvg).not.toBe("");
    const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids(fullscreenSvg)) expect(ids(inlineSvg)).not.toContain(id);
    expect(screen.getByTitle("Exit full screen (Esc)")).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps full screen open when the message row unmounts (virtualized list)", async () => {
    const { rerender } = render(
      <>
        <MermaidDiagram code={FLOWCHART} />
        <MermaidFullscreenHost />
      </>,
    );
    fireEvent.click(screen.getByTitle("Full screen"));
    await screen.findByRole("dialog");

    rerender(<MermaidFullscreenHost />);
    expect(
      screen.getByRole("dialog").querySelector("svg[data-beautiful-mermaid]"),
    ).toBeInTheDocument();
  });

  it("closes full screen from its close button", async () => {
    render(
      <>
        <MermaidDiagram code={FLOWCHART} />
        <MermaidFullscreenHost />
      </>,
    );

    fireEvent.click(screen.getByTitle("Full screen"));
    fireEvent.click(await screen.findByTitle("Exit full screen (Esc)"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
