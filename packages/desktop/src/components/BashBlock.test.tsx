/**
 * Lazy-parse contract for `BashBlock`.
 *
 * The block keeps a memoized parse for the truncated tail (cheap — bounded
 * by `maxLines`) and a memoized parse for the full output. The full parse
 * is gated on `showAll`: while the block is collapsed (the common
 * streaming case) the parse must short-circuit so each chunk arrival
 * doesn't re-parse the whole buffer on the main thread.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";

const parseAnsiMock = vi.fn((text: string) => text);
const getMessageFullContentMock = vi.fn();

vi.mock("@/lib/ansi-to-html", () => ({
  parseAnsi: (text: string) => parseAnsiMock(text),
}));

vi.mock("@/api/generated", () => ({
  getMessageFullContent: (messageId: number, signal?: AbortSignal) =>
    getMessageFullContentMock(messageId, signal),
  getGetMessageFullContentQueryKey: (messageId?: number) => [
    `/api/sessions/messages/${messageId}/full`,
  ],
}));

const useIsTouchDevice = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/hooks/useIsTouchDevice", () => ({ useIsTouchDevice }));

import { BashBlock } from "./BashBlock";

// Build content long enough to force the collapse toggle (>10 default lines).
function bigContent(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line-${i}`).join("\n");
}

beforeEach(() => {
  useIsTouchDevice.mockReturnValue(false);
  parseAnsiMock.mockClear();
  getMessageFullContentMock.mockReset();
});

describe("BashBlock lazy ANSI parse", () => {
  it("does not parse the full output while collapsed", () => {
    const content = bigContent(50);
    render(<BashBlock command="echo hi" content={content} />);

    // The truncated tail is parsed (bounded by maxLines). The full body
    // never is — every recorded call must be on a string strictly shorter
    // than the full content.
    expect(parseAnsiMock).toHaveBeenCalled();
    for (const call of parseAnsiMock.mock.calls) {
      expect(call[0].length).toBeLessThan(content.length);
    }
  });

  it("parses the full output once when expanded", async () => {
    const user = userEvent.setup();
    const content = bigContent(50);
    render(<BashBlock command="echo hi" content={content} />);

    parseAnsiMock.mockClear();
    await user.click(screen.getByRole("button", { name: /Show all 50/ }));

    // After expansion the full content must be parsed at least once.
    const fullCalls = parseAnsiMock.mock.calls.filter((c) => c[0] === content);
    expect(fullCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("BashBlock collapsed-header UX", () => {
  it("truncates the command header without a native hover title", () => {
    const longCommand = "echo " + "abcdefghij".repeat(40);
    const { container } = render(<BashBlock command={longCommand} content="ok" expanded={false} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain("truncate");
    expect(pre).not.toHaveAttribute("title");
  });

  it("wraps the command across lines when expanded", () => {
    const command = "ls -la && echo done";
    const { container } = render(<BashBlock command={command} content="ok" expanded={true} />);
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).not.toContain("truncate");
  });

  it("renders the command text in the high-contrast bash fg on success", () => {
    const { container } = render(<BashBlock command="echo hi" content="ok" />);
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("text-[var(--block-bash-fg)]");
    expect(pre?.className).not.toContain("text-destructive");
  });

  it("renders the command text in destructive color when the call errored", () => {
    // The whole header (icon, Bash label, command) must read as one red row
    // on failure — otherwise the command pre looks like normal output next
    // to a red header and label.
    const { container } = render(<BashBlock command="false" content="" isError />);
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("text-destructive");
    expect(pre?.className).not.toContain("text-[var(--block-bash-fg)]");
    expect(screen.getByText("Bash").className).toContain("text-destructive");
  });

  it("notifies onExpandedChange when the chevron toggle is clicked", async () => {
    const onExpandedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <BashBlock
        command="echo hi"
        content="ok"
        expanded={true}
        onExpandedChange={onExpandedChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Collapse output" }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("toggles when the user clicks anywhere on the collapsed header row", async () => {
    // Mirrors InlineDiffBlock: with auto-collapse / collapsed verbosity
    // modes the whole row needs to be hit-testable, not just the chevron.
    const onExpandedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <BashBlock
        command="echo hi"
        content="ok"
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );
    await user.click(screen.getByText("Bash"));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("does not double-toggle when the chevron inside the header row is clicked", async () => {
    // The chevron button lives inside the click-to-toggle row; if its
    // click propagated to the row handler too, we'd toggle twice and
    // appear to do nothing.
    const onExpandedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <BashBlock
        command="echo hi"
        content="ok"
        expanded={true}
        onExpandedChange={onExpandedChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Collapse output" }));
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });
});

describe("BashBlock server-truncated output", () => {
  it("never fetches a short preview on mount or opening the card", async () => {
    const user = userEvent.setup();
    getMessageFullContentMock.mockResolvedValue({ content: "earlier\nlast" });
    render(<BashBlock command="cat log" content="last" messageId={42} truncatedContent />);
    await user.click(screen.getByRole("button", { name: "Collapse output" }));
    await user.click(screen.getByRole("button", { name: "Expand output" }));
    expect(getMessageFullContentMock).not.toHaveBeenCalled();
  });

  it("loads previous lines explicitly even when fewer than ten lines remain", async () => {
    const user = userEvent.setup();
    getMessageFullContentMock.mockResolvedValue({ content: "earlier\nlast" });
    render(<BashBlock command="cat log" content="last" messageId={42} truncatedContent />);
    expect(getMessageFullContentMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Load previous lines" }));
    expect(await screen.findByText(/earlier/)).toBeInTheDocument();
    expect(getMessageFullContentMock).toHaveBeenCalledExactlyOnceWith(42, expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "Show last 10" }));
    expect(screen.queryByText(/earlier\nlast/)).not.toBeInTheDocument();
  });

  it("explains missing identity without pretending the preview is complete", async () => {
    const user = userEvent.setup();
    render(<BashBlock command="cat log" content="last" truncatedContent />);
    await user.click(screen.getByRole("button", { name: "Load previous lines" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reopen the conversation");
    expect(getMessageFullContentMock).not.toHaveBeenCalled();
  });

  it("fetches the full message content when expanding server-truncated output", async () => {
    const user = userEvent.setup();
    const truncated = bigContent(20);
    const fullOutput = bigContent(80);
    let resolveFullContent: (value: { content: string }) => void = () => undefined;
    getMessageFullContentMock.mockReturnValue(
      new Promise<{ content: string }>((resolve) => {
        resolveFullContent = resolve;
      }),
    );

    render(
      <BashBlock command="seq 80" content={truncated} messageId={2585} truncatedContent={true} />,
    );

    await user.click(screen.getByRole("button", { name: "Load previous lines" }));

    expect(await screen.findByText("Loading full output…")).toBeInTheDocument();
    // Do not expand the cached preview while waiting: the height jump can
    // unmount the row in Virtuoso and cancel the pending request.
    expect(screen.getByText(/line-19/).textContent).toBe(
      truncated.split("\n").slice(-10).join("\n"),
    );
    resolveFullContent({
      content: JSON.stringify({ aggregatedOutput: fullOutput, status: "completed" }),
    });
    expect(await screen.findByText(/line-79/)).toBeInTheDocument();
    expect(getMessageFullContentMock).toHaveBeenCalledTimes(1);
    expect(getMessageFullContentMock).toHaveBeenCalledWith(2585, expect.any(AbortSignal));
  });

  it("leaves touch long-press to native selection of the output", () => {
    useIsTouchDevice.mockReturnValue(true);
    const { container } = render(<BashBlock command="ls" content="file.txt" />);
    const block = container.querySelector("[data-bash-block]") as HTMLElement;

    expect(fireEvent.contextMenu(block)).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
