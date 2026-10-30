import { afterEach, describe, expect, it, vi } from "vitest";
import { useFullContentRequestsStore } from "@/stores/full-content-requests-store";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@/test-utils";
import { getMessageFullContent } from "@/api/generated";
import { AgentBlock } from "./AgentBlock";
import { FullContentPreview } from "./FullContentPreview";
import { deriveAgentStreamDisplayBlocks } from "./agentStreamDisplay";
import { __highlightCacheTestHelpers as highlightCache } from "./markdown/highlight-cache";
import { __markdownCacheTestHelpers as markdownCache } from "./markdown/markdown-tree-cache";

const apiMocks = vi.hoisted(() => ({
  getMessageFullContent: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/generated")>();
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...original,
    getMessageFullContent: apiMocks.getMessageFullContent,
    useGetMessageFullContent: (
      messageId: number,
      options?: Parameters<(typeof original)["useGetMessageFullContent"]>[1],
    ) =>
      useQuery({
        queryKey: [`/api/sessions/messages/${messageId}/full`],
        queryFn: ({ signal }) => apiMocks.getMessageFullContent(messageId, signal),
        enabled: !!messageId,
        ...options?.query,
      }),
  };
});

const fetchFull = vi.mocked(getMessageFullContent);

afterEach(() => {
  cleanup();
  useFullContentRequestsStore.setState({ requests: new Map() });
  fetchFull.mockReset();
  highlightCache.clear();
  markdownCache.clear();
});

describe("FullContentPreview", () => {
  it("retains a Bash card and loads the result row only when older lines are requested", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: JSON.stringify({ output: "earlier\nlast" }) });
    const args = JSON.stringify({ command: "pnpm test", output: "call tail" });
    render(
      <AgentBlock
        block={{
          id: "ws-call",
          messageDbId: 41,
          type: "tool_call",
          toolName: "Bash",
          toolUseId: "tool",
          content: args,
          toolArgs: args,
          truncatedContent: true,
        }}
        toolResultMap={
          new Map([
            [
              "tool",
              {
                id: "ws-result",
                messageDbId: 42,
                type: "tool_result",
                toolUseId: "tool",
                sourceToolName: "Bash",
                content: "last",
                truncatedContent: true,
              },
            ],
          ])
        }
      />,
    );
    expect(screen.queryByText("Truncated")).not.toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(fetchFull).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Load previous lines" }));
    expect(await screen.findByText(/earlier/)).toBeInTheDocument();
    expect(fetchFull).toHaveBeenCalledExactlyOnceWith(42, expect.any(AbortSignal));
  });

  it("loads only after an explicit action and releases content on collapse", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "complete content" });
    render(
      <FullContentPreview preview="safe preview" messageId={42}>
        {(content, mode) => <div data-testid={mode}>{content}</div>}
      </FullContentPreview>,
    );

    expect(screen.getByText("safe preview")).toBeInTheDocument();
    expect(fetchFull).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByTestId("full")).toHaveTextContent("complete content");
    expect(fetchFull).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByTestId("full")).not.toBeInTheDocument();
    expect(screen.getByText("safe preview")).toBeInTheDocument();
  });

  it("keeps the loaded content across a row remount", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "complete content" });
    const row = (
      <FullContentPreview preview="safe preview" messageId={43}>
        {(content, mode) => <div data-testid={mode}>{content}</div>}
      </FullContentPreview>
    );
    const first = render(row);
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByTestId("full")).toHaveTextContent("complete content");

    // Virtuoso remounts every row when a loaded message makes one much taller.
    first.unmount();
    render(row);
    expect(await screen.findByTestId("full")).toHaveTextContent("complete content");
    expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
  });

  it("surfaces an error and retries without duplicate in-flight requests", async () => {
    const user = userEvent.setup();
    fetchFull
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ content: "done" });
    render(
      <FullContentPreview preview="preview" messageId={7}>
        {(content) => <div>{content}</div>}
      </FullContentPreview>,
    );

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(fetchFull).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight request on unmount", async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    fetchFull.mockImplementation((_messageId, requestSignal) => {
      signal = requestSignal;
      return new Promise(() => undefined);
    });
    const view = render(
      <FullContentPreview preview="preview" messageId={9}>
        {(content) => <div>{content}</div>}
      </FullContentPreview>,
    );

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("resets immediately and ignores an old request when message identity changes", async () => {
    const user = userEvent.setup();
    let resolveFirst: ((value: { content: string }) => void) | undefined;
    fetchFull.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    const view = render(
      <FullContentPreview preview="first preview" messageId={1}>
        {(content) => <div>{content}</div>}
      </FullContentPreview>,
    );
    await user.click(screen.getByRole("button", { name: "Show all" }));
    const firstSignal = fetchFull.mock.calls[0][1];

    view.rerender(
      <FullContentPreview preview="second preview" messageId={2}>
        {(content) => <div>{content}</div>}
      </FullContentPreview>,
    );
    expect(screen.getByText("second preview")).toBeInTheDocument();
    expect(screen.queryByText("first preview")).not.toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.({ content: "stale full content" });
    expect(screen.queryByText("stale full content")).not.toBeInTheDocument();
  });

  it("drops loaded full content when props change", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "first full content" });
    const view = render(
      <FullContentPreview preview="first preview" messageId={1}>
        {(content) => <div>{content}</div>}
      </FullContentPreview>,
    );
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByText("first full content")).toBeInTheDocument();

    view.rerender(
      <FullContentPreview preview="second preview" messageId={2}>
        {(content) => <div>{content}</div>}
      </FullContentPreview>,
    );
    expect(screen.queryByText("first full content")).not.toBeInTheDocument();
    expect(screen.getByText("second preview")).toBeInTheDocument();
  });

  it("does not retain explicitly loaded full Markdown after collapse", async () => {
    const user = userEvent.setup();
    // Cache opt-out is driven by `disableCache` (explicitly loaded content), not
    // by size, so a short highlighted block covers it. A 4,000-line block made
    // this the slowest renderer test and timed out under CPU load.
    const full = `# Full content\n\n\`\`\`typescript\n${"const value = 1;\n".repeat(40)}\`\`\``;
    fetchFull.mockResolvedValue({ content: full });
    render(
      <AgentBlock
        block={{
          id: "msg-88",
          type: "text",
          content: "bounded preview",
          truncatedContent: true,
        }}
      />,
    );

    // Only the bounded preview may be cached; the loaded payload never is.
    const previewEntries = markdownCache.size();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByRole("heading", { name: "Full content" })).toBeInTheDocument();
    expect(markdownCache.size()).toBe(previewEntries);
    expect(highlightCache.snapshot().size).toBe(0);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("heading", { name: "Full content" })).not.toBeInTheDocument();
    expect(markdownCache.size()).toBe(previewEntries);
    expect(highlightCache.snapshot().size).toBe(0);
  });

  it("keeps truncated generic results out of the display pipeline", () => {
    const results = ["Read", "Edit", "mcp__chrome-devtools__take_screenshot"].map(
      (sourceToolName, index) => ({
        id: `msg-${90 + index}`,
        type: "tool_result" as const,
        sourceToolName,
        content: "bounded result preview",
        truncatedContent: true,
      }),
    );
    expect(deriveAgentStreamDisplayBlocks(results)).toEqual([]);
    render(<AgentBlock block={results[2]} />);
    expect(screen.queryByText(/Truncated/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lets go of a request once a revision replaces its preview", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "first revision in full" });
    const view = render(
      <FullContentPreview preview="first preview" messageId={46}>
        {(content, mode) => <div data-testid={mode}>{content}</div>}
      </FullContentPreview>,
    );
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByTestId("full")).toBeInTheDocument();

    view.rerender(
      <FullContentPreview preview="revised preview" messageId={46}>
        {(content, mode) => <div data-testid={mode}>{content}</div>}
      </FullContentPreview>,
    );
    expect(screen.getByTestId("preview")).toHaveTextContent("revised preview");
    expect(useFullContentRequestsStore.getState().requests.has(46)).toBe(false);
  });

  it("goes back to the preview when a pending load is cancelled", async () => {
    const user = userEvent.setup();
    fetchFull.mockImplementation(() => new Promise(() => undefined));
    render(
      <FullContentPreview preview="safe preview" messageId={44}>
        {(content, mode) => <div data-testid={mode}>{content}</div>}
      </FullContentPreview>,
    );

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("button", { name: /Loading/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Show all" })).toBeEnabled();
  });

  it("fetches afresh on every explicit Show all", async () => {
    const user = userEvent.setup();
    fetchFull
      .mockResolvedValueOnce({ content: "first revision" })
      .mockResolvedValueOnce({ content: "second revision" });
    render(
      <FullContentPreview preview="safe preview" messageId={45}>
        {(content, mode) => <div data-testid={mode}>{content}</div>}
      </FullContentPreview>,
    );

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByTestId("full")).toHaveTextContent("first revision");
    await user.click(screen.getByRole("button", { name: "Show less" }));
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByTestId("full")).toHaveTextContent("second revision");
  });

  it("offers copy on loaded text but never on its cut preview", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "complete text" });
    render(
      <AgentBlock
        block={{ id: "msg-94", type: "text", content: "cut text", truncatedContent: true }}
      />,
    );

    expect(screen.queryByTitle("Copy to clipboard")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByText("complete text")).toBeInTheDocument();
    expect(screen.getByTitle("Copy to clipboard")).toBeInTheDocument();
  });

  it("gates truncated subagent output behind an explicit load", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "complete subagent report" });
    render(
      <AgentBlock
        block={{
          id: "msg-93",
          type: "tool_result",
          sourceToolName: "Agent",
          content: "bounded subagent preview",
          truncatedContent: true,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findByText(/complete subagent report/)).toBeInTheDocument();
  });
});
