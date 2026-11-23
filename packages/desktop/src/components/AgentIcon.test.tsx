import { describe, expect, it } from "vitest";
import { render } from "@/test-utils";
import { AgentIcon } from "./AgentIcon";

describe("AgentIcon", () => {
  it("renders the visor geometry with Lucide SVG attributes and forwards props", () => {
    const { container } = render(
      <AgentIcon className="size-4" strokeWidth={1.8} aria-label="Agent" />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("stroke-width", "1.8");
    expect(svg).toHaveAttribute("aria-label", "Agent");
    expect(svg).toHaveClass("lucide", "lucide-agent", "size-4");
    expect(svg?.querySelectorAll("rect")).toHaveLength(1);
    expect(svg?.querySelectorAll("path")).toHaveLength(2);
  });
});
