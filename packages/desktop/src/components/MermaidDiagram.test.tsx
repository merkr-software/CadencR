import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import MermaidDiagram from "./MermaidDiagram";

// Stub the theme hook so the component does not pull in the settings API.
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: { appearance: "light" } }),
}));

const parse = vi.fn();
const renderFn = vi.fn();
const initialize = vi.fn();

// The component dynamically imports "mermaid"; mock the module wholesale.
vi.mock("mermaid", () => ({
  default: { initialize, parse, render: renderFn },
}));

const VALID = "graph TD\n  A-->B";
const INVALID = "graph TD\n  A--> )(*&";

describe("MermaidDiagram invalid-output gate", () => {
  beforeEach(() => {
    parse.mockReset();
    renderFn.mockReset();
    initialize.mockReset();
  });

  it("never calls render() when the diagram source is invalid", async () => {
    // parse() rejects on invalid syntax (mermaid's documented behaviour).
    parse.mockRejectedValue(new Error("Parse error on line 2"));

    render(<MermaidDiagram code={INVALID} />);

    await waitFor(() => expect(parse).toHaveBeenCalledWith(INVALID));
    // The DOM-leaking render() path must never be reached for invalid output.
    expect(renderFn).not.toHaveBeenCalled();
    // The error is surfaced to the user with the parser message.
    expect(await screen.findByText(/Could not render diagram/)).toBeInTheDocument();
  });

  it("renders the diagram when the source parses cleanly", async () => {
    parse.mockResolvedValue({ diagramType: "flowchart" });
    renderFn.mockResolvedValue({ svg: "<svg data-testid='ok'></svg>" });

    render(<MermaidDiagram code={VALID} />);

    await waitFor(() => expect(renderFn).toHaveBeenCalledWith(expect.any(String), VALID));
    // parse() gates render(): it must run first.
    expect(parse).toHaveBeenCalledWith(VALID);
  });
});
