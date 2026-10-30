import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtuosoHandle } from "react-virtuoso";
import { toast } from "sonner";
import { act, fireEvent, render, screen } from "@/test-utils";
import type { SessionPrompt } from "@/api/generated";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { MessageNavigator } from "./MessageNavigator";

const promptsQuery = vi.hoisted(() => ({
  data: undefined as { prompts: SessionPrompt[] } | undefined,
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListSessionPrompts: () => ({
    data: promptsQuery.data,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

afterEach(() => {
  promptsQuery.data = undefined;
  vi.restoreAllMocks();
});

function item(id: string, content: string, messageDbId?: number): DisplayItem {
  const type: AgentBlockData["type"] = id.startsWith("msg-") ? "user_message" : "text";
  return { kind: "block", key: id, block: { id, type, content, messageDbId } };
}

const ITEMS: DisplayItem[] = [
  item("msg-1", "First question", 1),
  item("a1", "Answer one"),
  item("msg-2", "Second question about the login flow", 2),
  item("a2", "Answer two"),
  item("msg-3", "Third", 3),
];

/** A fake Virtuoso scroller whose item list mounts the given block ids. */
function makeScroller(mountedIds: string[], clientHeight = 0): HTMLElement {
  const scroller = document.createElement("div");
  const list = document.createElement("div");
  list.dataset.testid = "virtuoso-item-list";
  for (const id of mountedIds) {
    const row = document.createElement("div");
    const inner = document.createElement("div");
    inner.dataset.blockId = id;
    row.appendChild(inner);
    list.appendChild(row);
  }
  scroller.appendChild(list);
  scroller.scrollTo = vi.fn();
  Object.defineProperty(scroller, "clientHeight", { value: clientHeight });
  document.body.appendChild(scroller);
  return scroller;
}

interface SetupOptions {
  items?: DisplayItem[];
  mounted?: string[];
  clientHeight?: number;
}

function setup({
  items = ITEMS,
  mounted = ["msg-1", "a1", "msg-2", "a2", "msg-3"],
  clientHeight = 0,
}: SetupOptions = {}) {
  const scrollerRef = { current: makeScroller(mounted, clientHeight) };
  const scrollToIndex = vi.fn();
  const virtuosoRef = createRef<VirtuosoHandle>() as { current: VirtuosoHandle | null };
  virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
  // Each turn load stays pending until the test settles it.
  const settleTurn = new Map<number, (found: boolean) => void>();
  const controls = {
    prepareJump: vi.fn(),
    loadPromptTurn: vi.fn(
      (messageDbId: number) =>
        new Promise<boolean>((resolve) => settleTurn.set(messageDbId, resolve)),
    ),
  };
  const view = (nextItems: DisplayItem[]) => (
    <MessageNavigator
      items={nextItems}
      virtuosoRef={virtuosoRef}
      scrollerRef={scrollerRef}
      controls={controls}
      shortcutsEnabled
    />
  );
  const { rerender } = render(view(items));
  return {
    scroller: scrollerRef.current,
    scrollToIndex,
    controls,
    settleTurn: (messageDbId: number, found: boolean) =>
      act(async () => settleTurn.get(messageDbId)?.(found)),
    rerender: (next: DisplayItem[]) => rerender(view(next)),
  };
}

function mockRailRect(): HTMLElement {
  const rail = screen.getByTestId("message-navigator");
  rail.getBoundingClientRect = () => ({ top: 0, height: 300 }) as DOMRect;
  return rail;
}

function prompt(id: number, preview: string): SessionPrompt {
  return { id, preview, image_count: 0, attachment_count: 0 };
}

describe("MessageNavigator", () => {
  it("draws one tick per loaded prompt without a server list", () => {
    setup();
    expect(screen.getAllByTestId("message-navigator-tick")).toHaveLength(3);
  });

  it("draws every prompt of the session, loaded or not", () => {
    promptsQuery.data = { prompts: [prompt(0, "Older"), prompt(1, "First question")] };
    setup({ items: ITEMS.slice(0, 2) });
    expect(screen.getAllByTestId("message-navigator-tick")).toHaveLength(2);
  });

  it("renders nothing without user messages", () => {
    setup({ items: [item("a1", "Only the agent")] });
    expect(screen.queryByTestId("message-navigator")).not.toBeInTheDocument();
  });

  it("previews the message under the pointer", () => {
    setup();
    const rail = mockRailRect();
    fireEvent.pointerMove(rail, { clientY: 150, pointerType: "mouse" });
    const preview = screen.getByTestId("message-navigator-preview");
    expect(preview).toHaveTextContent("Second question about the login flow");
    expect(preview).toHaveTextContent("2/3");

    fireEvent.pointerLeave(rail);
    expect(screen.queryByTestId("message-navigator-preview")).not.toBeInTheDocument();
  });

  it("glides to a nearby message after handing it the viewport", () => {
    const { scroller, controls, scrollToIndex } = setup({ clientHeight: 800 });
    fireEvent.click(mockRailRect(), { clientY: 250, detail: 1 });
    expect(controls.prepareJump).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("brings an off-screen message in by index", () => {
    const { scrollToIndex } = setup({ mounted: ["a2", "msg-3"] });
    fireEvent.click(mockRailRect(), { clientY: 10, detail: 1 });
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, align: "start" }),
    );
  });

  it("activates a tick from the keyboard by its own index", () => {
    const { scrollToIndex } = setup({ mounted: ["msg-3"] });
    fireEvent.click(screen.getAllByTestId("message-navigator-tick")[1], { detail: 0 });
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });

  it("loads an unloaded prompt's own turn, then jumps once its row exists", async () => {
    promptsQuery.data = { prompts: [prompt(0, "Older"), ...ITEMS.flatMap(toPrompt)] };
    const { controls, scrollToIndex, rerender, settleTurn } = setup({ mounted: [] });
    fireEvent.click(screen.getAllByTestId("message-navigator-tick")[0], { detail: 0 });
    expect(controls.loadPromptTurn).toHaveBeenCalledWith(0);
    expect(screen.getAllByTestId("message-navigator-tick")[0]).toHaveAttribute("aria-busy");

    // The turn lands: the store re-renders with the older prompt in it.
    await settleTurn(0, true);
    rerender([item("msg-0", "Older", 0), ...ITEMS]);
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    expect(screen.getAllByTestId("message-navigator-tick")[0]).not.toHaveAttribute("aria-busy");
  });

  it("reports a prompt that is no longer in the conversation", async () => {
    const toastError = vi.spyOn(toast, "error");
    promptsQuery.data = { prompts: [prompt(0, "Older"), ...ITEMS.flatMap(toPrompt)] };
    const { scrollToIndex, settleTurn } = setup({ mounted: [] });
    fireEvent.click(screen.getAllByTestId("message-navigator-tick")[0], { detail: 0 });
    await settleTurn(0, false);
    expect(toastError).toHaveBeenCalledWith("That message is no longer in the conversation.");
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("message-navigator-tick")[0]).not.toHaveAttribute("aria-busy");
  });

  it("ignores a cancelled load settling after another prompt was picked", async () => {
    const toastError = vi.spyOn(toast, "error");
    promptsQuery.data = {
      prompts: [prompt(-1, "Oldest"), prompt(0, "Older"), ...ITEMS.flatMap(toPrompt)],
    };
    const { settleTurn } = setup({ mounted: [] });
    const tick = (index: number) => screen.getAllByTestId("message-navigator-tick")[index];
    fireEvent.click(tick(0), { detail: 0 });
    fireEvent.click(tick(0), { detail: 0 }); // Clicking it again cancels.
    expect(tick(0)).not.toHaveAttribute("aria-busy");
    fireEvent.click(tick(1), { detail: 0 });

    await settleTurn(-1, false);
    expect(toastError).not.toHaveBeenCalled();
    expect(tick(1)).toHaveAttribute("aria-busy");
  });

  it("jumps to the previous message with ⌥↑", () => {
    // jsdom rects are all zero, so the top probe resolves to the last mounted row (msg-3).
    const { scrollToIndex } = setup({ mounted: ["a2", "msg-3"] });
    fireEvent.keyDown(document, { key: "ArrowUp", code: "ArrowUp", altKey: true });
    expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });
});

function toPrompt(displayItem: DisplayItem): SessionPrompt[] {
  if (displayItem.kind !== "block" || displayItem.block.messageDbId === undefined) return [];
  return [prompt(displayItem.block.messageDbId, displayItem.block.content)];
}
