// @vitest-environment jsdom
// Pinned to jsdom: the injection checks parse the SVG with a spec-faithful HTML parser.
import { describe, expect, it } from "vitest";
import { namespaceSvgIds, renderBeautifulMermaid, scopeBeautifulSvg } from "./mermaid-render";

const SUPPORTED: Record<string, string> = {
  flowchart: "graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[(DB)]",
  flowchartKeyword: "flowchart LR\n  A --> B",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Working: prompt",
  sequence: "sequenceDiagram\n  participant U as User\n  U->>S: hello\n  S-->>U: hi",
  class: "classDiagram\n  class Foo {\n    +bar() int\n  }\n  Foo <|-- Baz",
  er: "erDiagram\n  PROJECT ||--o{ FEATURE : contains",
  xychart: 'xychart-beta\n  title "Latency"\n  x-axis [a, b]\n  bar [1, 2]',
};

function render(code: string): string {
  const svg = renderBeautifulMermaid(code);
  if (svg === null) throw new Error(`expected beautiful-mermaid to render:\n${code}`);
  return svg;
}

function parse(svg: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = svg;
  return template.content;
}

describe("renderBeautifulMermaid", () => {
  it.each(Object.entries(SUPPORTED))("renders %s diagrams", (_, code) => {
    const root = parse(render(code)).firstElementChild;
    expect(root?.localName).toBe("svg");
    expect(root?.hasAttribute("data-beautiful-mermaid")).toBe(true);
  });

  it.each([
    ["gantt", "gantt\n  title Plan\n  section A\n  Task :a1, 2026-01-01, 3d"],
    ["pie", 'pie\n  "a" : 1\n  "b" : 2'],
    ["mindmap", "mindmap\n  root\n    child"],
    ["flowchart without a direction", "flowchart\n  A --> B"],
  ])("leaves %s to mermaid", (_, code) => {
    expect(renderBeautifulMermaid(code)).toBeNull();
  });

  it("looks past leading %% comment lines to find the header", () => {
    expect(renderBeautifulMermaid("%% a comment\n\nsequenceDiagram\n  A->>B: hi")).toContain(
      "<svg",
    );
  });

  it("accepts flowcharts whose statements end with a semicolon", () => {
    const svg = render("flowchart LR;\nA[Prompt] --> B{Has images?};\nB -->|yes| C[Blob cache];");
    expect(svg).toContain("Blob cache");
  });

  it("leaves semicolon-joined one-liners to mermaid", () => {
    expect(renderBeautifulMermaid("graph TD; A-->B; B-->C")).toBeNull();
  });

  it("themes through app tokens so a theme switch needs no re-render", () => {
    const svg = render(SUPPORTED.flowchart);
    expect(svg).toContain("--bg:var(--background)");
    expect(svg).toContain("--fg:var(--foreground)");
    expect(svg).toContain("--accent:var(--primary)");
  });

  it("never lets a label smuggle markup into the page", () => {
    const payloads = [
      'graph TD\n  A["<img src=x onerror=alert(1)>"] -->|"<script>alert(1)</script>"| B',
      'graph TD\n  A --> B\n  style A fill:red" onmouseover="alert(1)',
      "sequenceDiagram\n  participant A as <img src=x onerror=alert(1)>\n  A->>A: <script>x</script>",
      'erDiagram\n  A ||--o{ B : "<img onerror=1>"',
      'xychart-beta\n  title "<script>alert(1)</script>"\n  x-axis ["<img onerror=1>", b]\n  bar [1, 2]',
    ];
    for (const code of payloads) {
      const fragment = parse(render(code));
      expect(fragment.querySelectorAll("script, img, foreignObject, iframe, a")).toHaveLength(0);
      for (const element of fragment.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          expect(attribute.name).not.toMatch(/^on/i);
          if (/href$/i.test(attribute.name)) expect(attribute.value.startsWith("#")).toBe(true);
        }
      }
    }
  });
});

describe("scopeBeautifulSvg", () => {
  it("drops the font imports and confines every style rule to the diagram", () => {
    const svg = render(SUPPORTED.class);
    expect(svg).not.toContain("@import");
    expect(svg).not.toContain("googleapis");
    expect(svg).not.toMatch(/^\s*text \{/m);
    expect(svg).not.toMatch(/^\s*svg \{/m);
    expect(svg).toContain("svg[data-beautiful-mermaid] {");
    expect(svg).toContain("svg[data-beautiful-mermaid] .mono { font-family: var(--font-mono); }");
  });

  it("scopes the XY chart's second style block too", () => {
    const styles = render(SUPPORTED.xychart).match(/<style>[\s\S]*?<\/style>/g) ?? [];
    expect(styles.length).toBeGreaterThan(1);
    for (const style of styles) expect(style).not.toMatch(/^\s*svg \{/m);
  });

  it("is a no-op on markup without the rules it rewrites", () => {
    expect(scopeBeautifulSvg("<g></g>")).toBe("<g></g>");
  });
});

describe("namespaceSvgIds", () => {
  it("prefixes ids and keeps every internal reference resolvable", () => {
    const svg = namespaceSvgIds(render("graph TD\n  root --> A\n  A --> B"), "bm7-");
    const ids = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith("bm7-")).toBe(true);
    expect(ids.has("root")).toBe(false);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(ref)).toBe(true);
  });

  it("leaves data-id attributes alone", () => {
    expect(namespaceSvgIds('<g data-id="A" id="A"></g>', "p-")).toBe(
      '<g data-id="A" id="p-A"></g>',
    );
  });
});
