import { StrictMode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { LinkRoutingContext, type LinkRouting } from "./links/LinkRoutingContext";
import { Markdown } from "./Markdown";
import { useOpenDiffInEditor } from "./diff/OpenDiffInEditorContext";

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

    // Streamdown's stock `stagger` (40ms) delays word N of a re-parse by
    // `N * 40ms` with `animation-fill-mode: both` — the word is invisible until
    // then. Measured against the unconfigured component: a 40-word block hides
    // its tail for 1560ms, an 80-word block for 3160ms, and it keeps scaling
    // with the message. That is the "text disappears then reappears" and
    // "animation is too slow" report. See `STREAM_ANIMATION` for why the
    // bookkeeping that is supposed to exempt already-shown words does not.
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

    // The app mounts in `StrictMode`, whose double-invoke consumes the
    // render-phase bookkeeping Streamdown uses to tell new words from old, so
    // every word reads as new on every re-parse. With no stagger that is
    // invisible; with one it is the worst case above.
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

    it("does nothing when rendered outside an editor context", () => {
      vi.mocked(useOpenDiffInEditor).mockReturnValue(undefined);
      render(<Markdown content="see src/main.rs:42 for details" />);
      expect(() => fireEvent.click(screen.getByText("src/main.rs:42"))).not.toThrow();
    });
  });
});
