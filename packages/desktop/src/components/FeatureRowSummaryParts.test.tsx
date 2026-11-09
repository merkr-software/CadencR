import { describe, expect, it } from "vitest";
import { render } from "@/test-utils";
import type { RowSummary } from "@/lib/sidebar-row-summary";
import { FeatureRowReply } from "./FeatureRowSummaryParts";

function reply(summary: RowSummary | undefined, lines = 2): HTMLElement {
  const { container } = render(<FeatureRowReply summary={summary} lines={lines} />);
  const element = container.querySelector<HTMLElement>("[data-feature-preview]");
  if (!element) throw new Error("no reply rendered");
  return element;
}

const SUMMARY: RowSummary = { preview: "Wiring the toggle", todos: null, error: null };

describe("FeatureRowReply", () => {
  it("sets the reply in the room of its lines", () => {
    const element = reply(SUMMARY, 3);
    expect(element).toHaveTextContent("Wiring the toggle");
    expect(element).toHaveAttribute("data-feature-preview", "");
    expect(element).not.toHaveClass("italic");
    expect(element.style.height).toBe("3.75rem");
  });

  it("marks a missing reply as a placeholder", () => {
    const element = reply({ ...SUMMARY, preview: null });
    expect(element).toHaveTextContent("No reply yet");
    expect(element).toHaveAttribute("data-feature-preview", "empty");
    expect(element).toHaveClass("italic");
  });

  it("marks a reply that couldn't load as a placeholder, naming why on hover", () => {
    const element = reply({ ...SUMMARY, error: "summary failed" });
    expect(element).toHaveTextContent("Preview unavailable");
    expect(element).toHaveAttribute("data-feature-preview", "empty");
    expect(element).toHaveAttribute("title", "summary failed");
    expect(element).toHaveClass("italic");
  });

  it("holds a bar per line while it loads, in the same room", () => {
    const element = reply(undefined, 3);
    expect(element.children).toHaveLength(3);
    expect(element.style.height).toBe("3.75rem");
  });
});
