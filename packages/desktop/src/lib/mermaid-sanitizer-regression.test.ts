// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { renderBeautifulMermaid, renderWithMermaid } from "./mermaid-render";
import { sanitizeDiagramSvg } from "./sanitize-diagram-svg";

beforeAll(() => {
  // jsdom has no text layout; keep real Mermaid rendering and provide only
  // the geometry primitives it asks Chromium to measure.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 80,
  });
});

function parsed(svg: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = sanitizeDiagramSvg(svg);
  return root;
}

describe("real diagram renderer output", () => {
  it.each([
    ["flowchart LR\nA[Start] --> B[Finish]", "Start", "Finish"],
    ["sequenceDiagram\nparticipant U as User\nU->>S: Hello", "User", "Hello"],
  ])("preserves beautiful-mermaid labels for %s", (source, first, second) => {
    const svg = renderBeautifulMermaid(source);
    expect(svg).not.toBeNull();
    const root = parsed(svg ?? "");
    expect(root.querySelector("svg")).not.toBeNull();
    expect(root.textContent).toContain(first);
    expect(root.textContent).toContain(second);
    expect(root.querySelectorAll("path,line,rect").length).toBeGreaterThan(0);
  });

  it.each([
    ["flowchart LR; A[Start] --> B[Finish];", "Start", "Finish"],
    ['%%{init: {"htmlLabels":true}}%%\nflowchart LR; A[Start] --> B[Finish];', "Start", "Finish"],
    ['pie title Plan\n"Ready" : 3\n"Waiting" : 2', "Ready", "Waiting"],
    ["sequenceDiagram\nparticipant A as Alice\nA->>A: Hello", "Alice", "Hello"],
  ])(
    "preserves fallback Mermaid labels without foreign HTML for %s",
    async (source, first, second) => {
      const svg = await renderWithMermaid(source, "dark");
      const root = parsed(svg);
      expect(root.querySelector("svg")).not.toBeNull();
      expect(root.querySelector("foreignObject")).toBeNull();
      expect(root.textContent).toContain(first);
      expect(root.textContent).toContain(second);
      expect(root.querySelectorAll("path,line,rect").length).toBeGreaterThan(0);
    },
  );
});
