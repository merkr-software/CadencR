// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderBeautifulMermaid } from "./mermaid-render";
import { sanitizeDiagramSvg } from "./sanitize-diagram-svg";

function parsed(source: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = sanitizeDiagramSvg(source);
  return root;
}

describe("diagram SVG boundary", () => {
  it("removes executable content, foreign HTML and external references", () => {
    const root = parsed(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><foreignObject><img src=x onerror=alert(1) /></foreignObject>
      <a href="javascript:alert(1)"><text onclick="alert(1)">label</text></a>
      <image href="https://evil.test/pixel" /><use href="//evil.test/symbol.svg#node" />
      <animate attributeName="href" values="javascript:alert(1)" />
      <rect fill="url(https://evil.test/paint)" style="fill: url(https://evil.test/paint)" />
    </svg>`);
    expect(root.querySelector("script, foreignObject, animate, img")).toBeNull();
    expect(root.innerHTML).not.toMatch(/onload|onclick|onerror|evil\.test|javascript:/i);
    expect(root.querySelector("text")?.textContent).toBe("label");
  });

  it("keeps diagram geometry, theme styles and local marker references", () => {
    const root = parsed(`<svg viewBox="0 0 200 100" style="--fg:var(--foreground); color:var(--fg)">
      <style>.node{fill:var(--background);stroke:rgb(1,2,3)} #edge{marker-end:url(#arrow)}</style>
      <defs><marker id="arrow"><path d="M0 0L10 5L0 10z" /></marker></defs>
      <path id="edge" d="M1 2L30 40" marker-end="url(#arrow)" />
      <rect class="node" width="40" height="20" /><text x="20" y="10">Hello</text>
    </svg>`);
    expect(root.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 200 100");
    expect(root.querySelector("path#edge")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(root.querySelector("style")?.textContent).toContain("fill: var(--background)");
    expect(root.querySelector("style")?.textContent).toContain("[data-cadencr-diagram=");
    expect(root.querySelector("marker#arrow")).not.toBeNull();
    expect(root.querySelector("text")?.textContent).toBe("Hello");
  });

  it("drops CSS imports, remote and escaped URLs without leaking styles into the host", () => {
    const root = parsed(String.raw`<svg><style>
      @import url("https://evil.test/font.css");
      @font-face {font-family:evil;src:url(https://evil.test/font)}
      body { position:fixed; fill:red; background:image-set("//evil.test/pixel" 1x) }
      .node { stroke:url(https://evil.test/stroke); fill:u\72l(https://evil.test/paint); color:blue }
    </style><rect class="node" /></svg>`);
    const css = root.querySelector("style")?.textContent ?? "";
    expect(css).not.toMatch(/evil\.test|@import|@font-face|position|image-set/);
    expect(css).toContain("color: blue");
    expect(css).toMatch(/\[data-cadencr-diagram="diagram-\d+"\]:is\(body\)/);
  });

  it("preserves the ordinary beautiful-mermaid render output", () => {
    const svg = renderBeautifulMermaid("flowchart LR\nA[Start] --> B[Finish]");
    expect(svg).not.toBeNull();
    const root = parsed(svg ?? "");
    expect(root.querySelector("svg")).not.toBeNull();
    expect(root.querySelectorAll("path,rect").length).toBeGreaterThan(0);
    expect(root.textContent).toContain("Start");
    expect(root.textContent).toContain("Finish");
    expect(root.querySelector("style")?.textContent).toContain("data-cadencr-diagram");
  });
});
