import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.queryByText("Large content preview")).not.toBeInTheDocument();
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
        {(content) => <div data-testid="full">{content}</div>}
      </FullContentPreview>,
    );

    expect(screen.getByText("safe preview")).toBeInTheDocument();
    expect(fetchFull).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Load full content" }));
    expect(await screen.findByTestId("full")).toHaveTextContent("complete content");
    expect(fetchFull).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Collapse full content" }));
    expect(screen.queryByTestId("full")).not.toBeInTheDocument();
    expect(screen.getByText("safe preview")).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Load full content" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await user.click(screen.getByRole("button", { name: "Retry full content" }));
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

    await user.click(screen.getByRole("button", { name: "Load full content" }));
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
    await user.click(screen.getByRole("button", { name: "Load full content" }));
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
    await user.click(screen.getByRole("button", { name: "Load full content" }));
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

    await user.click(screen.getByRole("button", { name: "Load full content" }));
    expect(await screen.findByRole("heading", { name: "Full content" })).toBeInTheDocument();
    expect(markdownCache.size()).toBe(0);
    expect(highlightCache.snapshot().size).toBe(0);
    await user.click(screen.getByRole("button", { name: "Collapse full content" }));
    expect(screen.queryByRole("heading", { name: "Full content" })).not.toBeInTheDocument();
    expect(markdownCache.size()).toBe(0);
    expect(highlightCache.snapshot().size).toBe(0);
  });

  it("surfaces and renders a truncated generic result through the display pipeline", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "complete generic tool output" });
    const [visible] = deriveAgentStreamDisplayBlocks([
      {
        id: "msg-90",
        type: "tool_result",
        sourceToolName: "Read",
        content: "bounded result preview",
        truncatedContent: true,
      },
    ]);
    expect(visible).toBeDefined();
    if (!visible) throw new Error("expected truncated result to remain visible");
    render(<AgentBlock block={visible} />);

    expect(screen.getByText("bounded result preview")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load full content" }));
    expect(await screen.findByText("complete generic tool output")).toBeInTheDocument();
  });

  it("keeps a loaded file-change result inspectable", async () => {
    const user = userEvent.setup();
    fetchFull.mockResolvedValue({ content: "complete Edit result with diagnostics" });
    render(
      <AgentBlock
        block={{
          id: "msg-91",
          type: "tool_result",
          sourceToolName: "Edit",
          content: "bounded Edit preview",
          truncatedContent: true,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load full content" }));
    expect(await screen.findByText("complete Edit result with diagnostics")).toHaveProperty(
      "tagName",
      "PRE",
    );
  });
});
