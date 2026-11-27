import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/test-utils";
import type { ReactElement } from "react";
import { Markdown } from "@/components/Markdown";
import { LinkRoutingContext, type LinkRouting } from "@/components/links/LinkRoutingContext";
import { RichContentViewerHost } from "@/components/markdown/RichContentViewer";
import { __markdownCacheTestHelpers as cache } from "@/components/markdown/markdown-tree-cache";
import { useRichViewerStore } from "@/stores/rich-viewer-store";

const state = vi.hoisted(() => ({ phone: true, wide: true, tall: true, href: "/a" }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouterState: ({ select }: { select: (s: { location: { href: string } }) => string }) =>
    select({ location: { href: state.href } }),
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => state.phone }));
vi.mock("@/hooks/useContentOverflow", () => ({
  useContentOverflow: (enabled: boolean) => ({
    ref: () => undefined,
    wide: enabled && state.wide,
    tall: enabled && state.tall,
  }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const TABLE = "| file | purpose |\n| --- | --- |\n| `a.py` | First |\n| beta | Second |\n";
const CODE = "```python\nprint('a very long line')\n```";

/** user-event installs its own clipboard on setup: spy on that one. */
function spyClipboard() {
  return vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
}

/** A message, with the app's root viewer host beside it. */
function withHost(message: ReactElement): ReactElement {
  return (
    <>
      {message}
      <RichContentViewerHost />
    </>
  );
}

beforeEach(() => {
  useRichViewerStore.setState({ open: null });
  cache.clear();
  state.phone = true;
  state.wide = true;
  state.tall = true;
  state.href = "/a";
  toast.success.mockClear();
});

describe("rich blocks in a message", () => {
  it("keeps the desktop table scrolling sideways in its own box, with no Expand", () => {
    state.phone = false;
    const { container } = render(<Markdown content={TABLE} cacheKey="t-desktop" />);
    const table = container.querySelector("table");
    expect(table?.parentElement).toHaveClass("overflow-x-auto");
    expect(screen.queryByRole("button", { name: "Expand table" })).not.toBeInTheDocument();
  });

  it("renders a phone table that fits inline, without a preview", () => {
    state.wide = false;
    const { container } = render(<Markdown content={TABLE} cacheKey="t-fits" />);
    expect(container.querySelector("[data-rich-table]")).toHaveAttribute(
      "data-rich-table",
      "inline",
    );
    expect(screen.queryByRole("button", { name: "Expand table" })).not.toBeInTheDocument();
  });

  it("clips a wide phone table, never scrolling it inside the transcript", () => {
    const { container } = render(<Markdown content={TABLE} cacheKey="t-wide" />);
    const block = container.querySelector("[data-rich-table]");
    expect(block).toHaveAttribute("data-rich-table", "preview");
    const clip = container.querySelector("table")?.parentElement;
    expect(clip).toHaveClass("overflow-hidden", "max-h-60");
    expect(clip).not.toHaveClass("overflow-x-auto");
    expect(container.querySelector('[data-rich-fade="right"]')).toBeInTheDocument();
    expect(container.querySelector('[data-rich-fade="bottom"]')).toBeInTheDocument();
  });

  it("opens the table full screen, copies it as Markdown and closes", async () => {
    const { user } = render(withHost(<Markdown content={TABLE} cacheKey="t-viewer" />));
    const writeText = spyClipboard();
    expect(document.querySelector("[data-rich-viewer]")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand table" }));
    const dialog = await screen.findByRole("dialog");
    const viewport = dialog.querySelector("[data-rich-viewer]");
    expect(viewport).toHaveClass("touch-pan-x", "touch-pan-y", "overflow-auto");
    expect(within(dialog).getByText("Second")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Copy table" }));
    expect(writeText).toHaveBeenCalledWith(
      "| file | purpose |\n| --- | --- |\n| `a.py` | First |\n| beta | Second |",
    );

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Back on the control that opened it.
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand table" })).toHaveFocus());
  });

  it("keeps the viewer open when the message row remounts, nothing mounted before", async () => {
    const { user, rerender } = render(withHost(<Markdown content={TABLE} cacheKey="t-row" />));
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Expand table" }));
    await screen.findByRole("dialog");
    // Virtuoso recycles the row: the message unmounts.
    rerender(withHost(<span />));
    expect(within(screen.getByRole("dialog")).getByText("Second")).toBeInTheDocument();
  });

  it("closes the viewer when the page navigates away", async () => {
    const { user, rerender } = render(withHost(<Markdown content={TABLE} cacheKey="t-nav" />));
    await user.click(screen.getByRole("button", { name: "Expand table" }));
    await screen.findByRole("dialog");
    state.href = "/b";
    rerender(withHost(<Markdown content={TABLE} cacheKey="t-nav" />));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useRichViewerStore.getState().open).toBeNull();
  });

  it("opens a link in the viewer as the message would", async () => {
    const routing: LinkRouting = {
      activate: vi.fn(),
      activateConversation: vi.fn(async () => undefined),
      setHoverLink: vi.fn(),
    };
    const linked = "| site |\n| --- |\n| [docs](https://example.com/docs) |\n";
    const { user } = render(
      withHost(
        <LinkRoutingContext.Provider value={routing}>
          <Markdown content={linked} cacheKey="t-link" />
        </LinkRoutingContext.Provider>,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Expand table" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByText("docs"));
    expect(routing.activate).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("keeps the desktop code block as it was", () => {
    state.phone = false;
    const { container } = render(<Markdown content={CODE} cacheKey="c-desktop" />);
    expect(container.querySelector("pre")).toHaveClass("overflow-x-auto");
    expect(screen.queryByRole("button", { name: /^Expand/ })).not.toBeInTheDocument();
  });

  it("renders a phone code block that fits inline, Copy kept", () => {
    state.wide = false;
    const { container } = render(<Markdown content={CODE} cacheKey="c-fits" />);
    expect(container.querySelector("pre")).not.toHaveClass("max-h-60");
    expect(container.querySelector("pre")).not.toHaveClass("overflow-x-auto");
    expect(screen.queryByRole("button", { name: /^Expand/ })).not.toBeInTheDocument();
    expect(screen.getByTitle("Copy to clipboard")).toHaveClass("phone:h-11", "phone:min-w-11");
  });

  it("opens a wide phone code block full screen and copies its source", async () => {
    const { container, user } = render(withHost(<Markdown content={CODE} cacheKey="c-wide" />));
    const writeText = spyClipboard();
    expect(container.querySelector("pre")).toHaveClass("overflow-hidden", "max-h-60");

    await user.click(screen.getByRole("button", { name: "Expand python code" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("python").length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Copy python" }));
    expect(writeText).toHaveBeenCalledWith("print('a very long line')");
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });
});
