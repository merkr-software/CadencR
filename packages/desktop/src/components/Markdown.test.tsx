import { StrictMode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { LinkRoutingContext, type LinkRouting } from "./links/LinkRoutingContext";
import { Markdown } from "./Markdown";
import { MarkdownImageProvider } from "./markdown-image";
import { useOpenDiffInEditor } from "./diff/OpenDiffInEditorContext";
import { LARGE_CODE_LINE_THRESHOLD } from "./markdown/LargeCodeBlock";

vi.mock("./diff/OpenDiffInEditorContext", () => ({
  useOpenDiffInEditor: vi.fn(),
}));

const words = (count: number): string =>
  Array.from({ length: count }, (_, i) => `word${i}`).join(" ");

const animatedSpans = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-sd-animate]"));

describe("Markdown", () => {
  it("renders plain text content", () => {
    render(<Markdown content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders headings", () => {
    render(<Markdown content="# Heading 1" />);
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("renders h2 heading", () => {
    render(<Markdown content="## Heading 2" />);
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  it("renders bold text", () => {
    render(<Markdown content="**bold text**" />);
    expect(screen.getByText("bold text")).toBeInTheDocument();
  });

  it("renders a link", () => {
    render(<Markdown content="[Click here](https://example.com)" />);
    const link = screen.getByRole("link", { name: "Click here" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("opens a serialized conversation reference when its full label is clicked", async () => {
    const activateConversation = vi.fn(async () => undefined);
    const routing: LinkRouting = {
      activate: vi.fn(),
      activateConversation,
      setHoverLink: vi.fn(),
    };
    const { user } = render(
      <LinkRoutingContext.Provider value={routing}>
        <Markdown content="Read [@@Cadencr / Prompt references](cadencr-conversation:feature/42)" />
      </LinkRoutingContext.Provider>,
    );

    const link = screen.getByRole("link", { name: "@@Cadencr / Prompt references" });
    expect(link).toHaveAttribute("href", "cadencr-conversation:feature/42");
    await user.click(link);
    expect(activateConversation).toHaveBeenCalledWith(42);
  });

  it("keeps serialized conversation references literal inside code", () => {
    const reference = "[@@Cadencr / Work](cadencr-conversation:feature/42)";
    render(<Markdown content={`\`${reference}\`\n\n\`\`\`text\n${reference}\n\`\`\``} />);
    expect(screen.queryByRole("link", { name: "@@Cadencr / Work" })).not.toBeInTheDocument();
    expect(screen.getAllByText(reference)).toHaveLength(2);
  });

  it("renders unordered list", () => {
    render(<Markdown content={"- item one\n- item two"} />);
    expect(screen.getByText("item one")).toBeInTheDocument();
    expect(screen.getByText("item two")).toBeInTheDocument();
  });

  it("renders ordered list", () => {
    render(<Markdown content={"1. first\n2. second"} />);
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  // `list-style-position: outside` paints the marker to the LEFT of the content
  // box. Indenting with a margin leaves it outside the element, where the agent
  // stream's `overflow-x-hidden` scroller clips it — a `9.` fits in the
  // overhang but a `10.` loses its leading digit, silently. Padding reserves the
  // space inside the box. jsdom has no layout, so this guards the rule rather
  // than the pixels.
  it.each(["ul", "ol"] as const)("indents %s with padding, not margin", (tag) => {
    const source = tag === "ol" ? "1. first\n2. second" : "- first\n- second";
    const { container } = render(<Markdown content={source} />);
    const list = container.querySelector(tag);
    expect(list?.className).toMatch(/\bps-\[/);
    expect(list?.className).not.toMatch(/\bm[lsx]-/);
  });

  it("renders inline code", () => {
    render(<Markdown content="Use `console.log()` to debug" />);
    expect(screen.getByText("console.log()")).toBeInTheDocument();
  });

  it("renders fenced code block with language and syntax highlighting", () => {
    render(<Markdown content={"```typescript\nconst x = 1;\n```"} />);
    expect(screen.getByText("typescript")).toBeInTheDocument();
    // With syntax highlighting, "const x = 1;" is split across multiple spans
    const codeEl = document.querySelector("code.hljs");
    expect(codeEl).toBeInTheDocument();
    expect(codeEl?.textContent).toContain("const x = 1;");
  });

  it("renders fenced code block without language as a block with 'text' label", () => {
    render(<Markdown content={"```\nsome output\n```"} />);
    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("some output")).toBeInTheDocument();
  });

  it("keeps ordinary fences highlighted and routes threshold-sized fences to the bounded viewer", () => {
    const ordinary = render(<Markdown content={"```typescript\nconst x = 1;\n```"} />);
    expect(ordinary.container.querySelector("code.hljs")).toBeInTheDocument();
    ordinary.unmount();

    const code = Array.from(
      { length: LARGE_CODE_LINE_THRESHOLD },
      (_, index) => `line ${index}`,
    ).join("\n");
    const large = render(<Markdown content={`\`\`\`typescript\n${code}\n\`\`\``} />);
    expect(screen.getByText(/large code — virtualized for performance/i)).toBeInTheDocument();
    expect(large.container.querySelector("code.hljs")).not.toBeInTheDocument();
  });

  it("renders inline raw HTML", () => {
    render(<Markdown content={"Press <kbd>Ctrl</kbd> to continue"} />);
    const kbd = document.querySelector("kbd");
    expect(kbd).toBeInTheDocument();
    expect(kbd?.textContent).toBe("Ctrl");
  });

  it("renders block-level raw HTML", () => {
    render(<Markdown content={"<details><summary>More</summary><span>Hidden</span></details>"} />);
    expect(document.querySelector("details")).toBeInTheDocument();
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it.each(["Before", "<b>Before</b>"])(
    "keeps incomplete images pending until their URL is complete after %s",
    (prefix) => {
      const Renderer = vi.fn(({ src }: { src?: string }) => <img src={src} alt="Loaded diagram" />);
      const renderImage = (suffix: string) => (
        <MarkdownImageProvider value={Renderer}>
          <Markdown content={`${prefix} ![diagram](${suffix}`} isStreaming />
        </MarkdownImageProvider>
      );
      const { container, rerender } = render(renderImage("https://exampl"));
      expect(screen.getByLabelText("Loading image")).toBeInTheDocument();
      expect(container.querySelector("img")).toBeNull();
      expect(Renderer).not.toHaveBeenCalled();

      rerender(renderImage("https://example.com/diagram.png)"));
      expect(screen.queryByLabelText("Loading image")).not.toBeInTheDocument();
      expect(screen.getByAltText("Loaded diagram")).toHaveAttribute(
        "src",
        "https://example.com/diagram.png",
      );
    },
  );

  it.each(["Before", "<b>Before</b>"])("does not activate incomplete links after %s", (prefix) => {
    render(<Markdown content={`${prefix} [pending](https://exampl`} isStreaming />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each(["streamdown:other", "STREAMDOWN:other", "javascript:alert(1)"])(
    "does not allow %s through the image sentinel exception",
    (src) => {
      const { container } = render(<Markdown content={`<img src="${src}" alt="blocked">`} />);
      expect(container.querySelector("img")).not.toHaveAttribute("src", src);
    },
  );

  it("strips dangerous HTML (script tags and event handlers)", () => {
    render(
      <Markdown
        content={'<img src="x" onerror="alert(1)" alt="pic"><script>alert(2)</script>Safe'}
      />,
    );
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(document.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(screen.getByText("Safe")).toBeInTheDocument();
  });

  it("strips javascript: URLs from raw HTML links", () => {
    render(<Markdown content={'<a href="javascript:alert(1)">click me</a>'} />);
    expect(screen.getByText("click me")).not.toHaveAttribute("href", "javascript:alert(1)");
  });

  it("unwraps <picture> so only the <img> loads, and drops the link's external mark", () => {
    const { container } = render(
      <Markdown
        content={
          '<h2><a href="https://example.com/retrigger"><picture>' +
          '<source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg">' +
          '<img alt="Retrigger" src="https://example.com/light.svg" align="right">' +
          "</picture></a>Confidence Score: 5/5</h2>"
        }
      />,
    );
    const link = screen.getByRole("link", { name: "Retrigger" });
    expect(container.querySelector("picture, source")).toBeNull();
    expect(link.querySelector("img")).toHaveAttribute("src", "https://example.com/light.svg");
    expect(link.querySelector("svg")).toBeNull();
    expect(link).toHaveAttribute("data-image-link", "true");
  });

  it("keeps the external mark on a plain web link", () => {
    render(<Markdown content="[docs](https://example.com/docs)" />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.querySelector("svg")).not.toBeNull();
    expect(link).not.toHaveAttribute("data-image-link");
  });

  it("keeps the external mark on an icon-and-text link", () => {
    render(
      <Markdown content='<a href="https://example.com/fix"><img alt="" src="https://example.com/i.svg"> Fix in Cursor</a>' />,
    );
    const link = screen.getByRole("link", { name: /Fix in Cursor/ });
    expect(link.querySelector("svg")).not.toBeNull();
    expect(link).not.toHaveAttribute("data-image-link");
  });

  it("applies custom className", () => {
    const { container } = render(<Markdown content="text" className="custom-class" />);
    expect(container.firstChild).toHaveClass("custom-class");
  });

  it("preprocesses PLAN_START/PLAN_END markers", () => {
    render(<Markdown content="---PLAN_START---\nPlan content\n---PLAN_END---" />);
    expect(screen.getByText(/Plan content/)).toBeInTheDocument();
  });

  it("renders blockquote", () => {
    render(<Markdown content="> A quote" />);
    expect(screen.getByText("A quote")).toBeInTheDocument();
  });

  it("renders empty content without crashing", () => {
    const { container } = render(<Markdown content="" />);
    expect(container).toBeInTheDocument();
  });

  describe("streaming reveal animation", () => {
    // The per-word reveal splits every text node into its own <span>. That is
    // affordable for the one block currently receiving tokens and ruinous for
    // the thousands of settled blocks behind it, so the gating is load-bearing
    // rather than cosmetic. `mode="static"` alone does NOT prevent the split —
    // only withholding `animated` does.
    it("splits words into animated spans for the streaming block", () => {
      const { container } = render(<Markdown content="alpha beta" isStreaming />);
      const spans = container.querySelectorAll("[data-sd-animate]");
      expect(spans.length).toBeGreaterThan(0);
    });

    it("adds no animation spans to settled blocks", () => {
      const { container } = render(<Markdown content="alpha beta" />);
      expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0);
      expect(screen.getByText("alpha beta")).toBeInTheDocument();
    });

    it("adds no animation spans to cached history blocks", () => {
      const { container } = render(<Markdown content="gamma delta" cacheKey="history-block" />);
      expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0);
    });

    // Even with upstream's StrictMode fix, queued animation delays would hide
    // the tail of a large burst. Every newly received word must be visible now.
    it("never holds a word behind an animation delay", () => {
      const { container } = render(<Markdown content={words(60)} isStreaming />);
      const spans = animatedSpans(container);
      expect(spans.length).toBeGreaterThan(20);
      expect(spans.filter((span) => span.style.getPropertyValue("--sd-delay") !== "")).toEqual([]);
    });

    // A CSS animation replays when its element is created or its animation
    // properties change. Words already on screen must keep both stable, or the
    // whole paragraph re-fades on every streamed chunk.
    it("reuses the spans of already-visible words when more tokens arrive", () => {
      const { container, rerender } = render(<Markdown content={words(8)} isStreaming />);
      const firstWord = animatedSpans(container)[0];
      rerender(<Markdown content={words(24)} isStreaming />);

      const grown = animatedSpans(container);
      expect(grown).toHaveLength(24);
      expect(grown[0]).toBe(firstWord);
      expect(grown.filter((span) => span.style.getPropertyValue("--sd-delay") !== "")).toEqual([]);
    });

    // StrictMode must retain the same immediate reveal behavior.
    it("stays delay-free under StrictMode's double render", () => {
      const { container } = render(
        <StrictMode>
          <Markdown content={words(60)} isStreaming />
        </StrictMode>,
      );
      const spans = animatedSpans(container);
      expect(spans.length).toBeGreaterThan(20);
      expect(spans.filter((span) => span.style.getPropertyValue("--sd-delay") !== "")).toEqual([]);
    });
  });

  describe("file references", () => {
    it("renders a file:line reference as a clickable link", () => {
      render(<Markdown content="see src/main.rs:42 for details" />);
      expect(screen.getByText("src/main.rs:42")).toBeInTheDocument();
    });

    it("opens the file at the referenced line on click", () => {
      const openInEditor = vi.fn();
      vi.mocked(useOpenDiffInEditor).mockReturnValue(openInEditor);
      render(<Markdown content="see src/main.rs:42 for details" />);
      fireEvent.click(screen.getByText("src/main.rs:42"));
      expect(openInEditor).toHaveBeenCalledWith("src/main.rs", 42, undefined);
    });

    // A `<` anywhere in the message routes it through rehype-sanitize, whose
    // protocol allowlist reads `foo.ts:` or `file:` as an unknown scheme.
    it.each([
      ["a bare file:line link", "[main.rs](main.rs:42)", "main.rs", 42],
      ["a file:// link", "[main.rs](file:///repo/src/main.rs)", "/repo/src/main.rs", undefined],
      ["a Windows drive link", "[main.rs](C:/repo/main.rs:7)", "C:/repo/main.rs", 7],
    ])("keeps %s clickable in a message that contains raw HTML", (_, link, path, line) => {
      const openInEditor = vi.fn();
      vi.mocked(useOpenDiffInEditor).mockReturnValue(openInEditor);
      render(<Markdown content={`Returns Vec<T>, see ${link}`} />);
      fireEvent.click(screen.getByText("main.rs"));
      expect(openInEditor).toHaveBeenCalledWith(path, line, undefined);
    });

    it("drops a hand-written envelope that doesn't carry a file link", () => {
      vi.mocked(useOpenDiffInEditor).mockReturnValue(vi.fn());
      render(<Markdown content={'<a href="cadencr-agent-file:javascript%3Aalert(1)">x</a>'} />);
      expect(screen.getByText("x").closest("a")).not.toHaveAttribute("href");
    });

    it("still strips an unknown scheme that merely contains a slash", () => {
      vi.mocked(useOpenDiffInEditor).mockReturnValue(vi.fn());
      render(<Markdown content={"Vec<T> [x](vbscript:run/x.rs)"} />);
      expect(screen.getByText("x").closest("a")).not.toHaveAttribute("href", "vbscript:run/x.rs");
    });

    it("does nothing when rendered outside an editor context", () => {
      vi.mocked(useOpenDiffInEditor).mockReturnValue(undefined);
      render(<Markdown content="see src/main.rs:42 for details" />);
      expect(() => fireEvent.click(screen.getByText("src/main.rs:42"))).not.toThrow();
    });
  });
});
