import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { LinkRoutingContext, type LinkRouting } from "@/components/links/LinkRoutingContext";
import { MarkdownLink } from "./markdown-link";

vi.mock("@/components/diff/OpenDiffInEditorContext", () => ({
  useOpenDiffInEditor: () => null,
}));

function renderRouted(href: string): LinkRouting {
  const routing: LinkRouting = {
    activate: vi.fn(),
    activateConversation: vi.fn(async () => undefined),
    setHoverLink: vi.fn(),
  };
  render(
    <LinkRoutingContext.Provider value={routing}>
      <p>
        See <MarkdownLink href={href}>the docs</MarkdownLink>
        <span>for details</span>
      </p>
    </LinkRoutingContext.Provider>,
  );
  return routing;
}

function select(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe("MarkdownLink", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("opens a web link on a plain click or tap, without a modifier", () => {
    const routing = renderRouted("https://example.com/docs");
    const link = screen.getByRole("link", { name: "the docs" });

    // `false` = default prevented: the app window itself must not navigate.
    expect(fireEvent.click(link)).toBe(false);
    expect(routing.activate).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("does not open when the click ends a drag-selection of the link text", () => {
    const routing = renderRouted("https://example.com/docs");
    const link = screen.getByRole("link", { name: "the docs" });
    select(link);

    fireEvent.click(link);

    expect(routing.activate).not.toHaveBeenCalled();
  });

  it("opens even when an unrelated selection exists elsewhere", () => {
    const routing = renderRouted("https://example.com/docs");
    select(screen.getByText("for details"));

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));

    expect(routing.activate).toHaveBeenCalledTimes(1);
  });

  it.each(["mailto:team@example.com", "#user-content-fn-1", "docs/setup.md"])(
    "keeps the non-web link %s inert on a plain click, routed on Cmd/Ctrl+Click",
    (href) => {
      const routing = renderRouted(href);
      const link = screen.getByRole("link", { name: "the docs" });

      expect(fireEvent.click(link)).toBe(false);
      expect(routing.activate).not.toHaveBeenCalled();

      fireEvent.click(link, { metaKey: true });
      expect(routing.activate).toHaveBeenCalledWith(href);
    },
  );

  it("names a web link's destination and marks it external", () => {
    renderRouted("https://example.com/docs");
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("title", "https://example.com/docs");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("leaves non-web links unmarked", () => {
    renderRouted("mailto:team@example.com");
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).not.toHaveAttribute("title");
    expect(link.querySelector("svg")).toBeNull();
  });
});
