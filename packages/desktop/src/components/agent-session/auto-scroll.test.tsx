import { describe, it, expect, vi, beforeEach } from "vitest";
import { forwardRef, useImperativeHandle, useRef, useState, type ForwardedRef } from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";
import { AgentSession } from "./AgentSession";
import type { AgentBlockData } from "@/types/agent-block";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";

// PromptEditor renders a contenteditable surface backed by CodeMirror, which
// jsdom can't drive. Swap in a real <textarea> so the send-flow test can
// type and trigger onSend.
vi.mock("../prompt-editor/PromptEditor", () => {
  const MockPromptEditor = forwardRef(function MockPromptEditor(
    {
      initialText,
      onChange,
      placeholder,
      disabled,
    }: {
      initialText?: string;
      onChange?: (text: string) => void;
      placeholder?: string;
      disabled?: boolean;
    },
    ref: ForwardedRef<{
      focus: () => void;
      clear: () => void;
      setText: (text: string) => void;
      getText: () => string;
    }>,
  ) {
    const [value, setValue] = useState(initialText ?? "");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        clear: () => {
          setValue("");
          onChange?.("");
        },
        setText: (text: string) => {
          setValue(text);
          onChange?.(text);
        },
        getText: () => value,
      }),
      [onChange, value],
    );
    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange?.(event.target.value);
        }}
        placeholder={placeholder}
        disabled={disabled}
      />
    );
  });
  return { PromptEditor: MockPromptEditor };
});

// The global react-virtuoso test mock exposes a custom event so tests
// can deterministically simulate Virtuoso reaching the top item.

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetFeatureWorkingDir: vi.fn(() => ({ data: null })),
  useGetWorkspaceSetting: vi.fn(() => ({ data: null })),
  useListFiles: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/api/agentRuntime", () => ({
  DEFAULT_CLAUDE_PROFILE_NAME: "default",
  useAgentCatalog: vi.fn(() => ({
    data: {
      default_provider: "claude_code",
      providers: [
        {
          id: "claude_code",
          label: "Claude",
          status: "available",
          models: [{ id: "opus", label: "Opus" }],
          default_model: "opus",
        },
      ],
    },
    isLoading: false,
  })),
  useClaudeCodeProfiles: vi.fn(() => ({
    data: {
      active: "default",
      profiles: [{ name: "bedrock", env: {} }],
    },
    isLoading: false,
    isError: false,
  })),
}));

vi.mock("@/hooks/usePromptDraft", () => ({
  usePromptDraft: vi.fn(() => ({ saveDraft: vi.fn(), initialDraft: null })),
}));

vi.mock("@/hooks/usePromptHistory", () => ({
  usePromptHistory: vi.fn(() => ({
    addEntry: vi.fn(),
    history: [],
    historyIndex: -1,
    navigateUp: vi.fn(() => null),
    navigateDown: vi.fn(() => null),
    resetNavigation: vi.fn(),
  })),
}));

vi.mock("@/hooks/useImageAttachments", () => ({
  useImageAttachments: vi.fn(() => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    restoreAttachments: vi.fn(),
    dragHandlers: {},
    isDragging: false,
  })),
}));

function makeBlock(id: string, content: string): AgentBlockData {
  return { id, type: "text", content };
}

function getAutoScrollButton(): HTMLElement {
  return screen.getByRole("button", { name: /auto-scroll/i });
}

function getScroller(): HTMLElement {
  return screen.getByTestId("agent-stream-scroller");
}

function stubGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
}

function dispatchScroll(el: HTMLElement, scrollTop: number): void {
  el.scrollTop = scrollTop;
  act(() => {
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

/** Drive Virtuoso's measurement-aware `atBottomStateChange` callback. */
function fireAtBottomChange(atBottom: boolean): void {
  act(() => {
    getScroller().dispatchEvent(
      new CustomEvent("virtuoso-at-bottom-change", { detail: { atBottom }, bubbles: true }),
    );
  });
}

/** Drive Virtuoso's `totalListHeightChanged` callback. */
function fireTotalHeightChange(height: number): void {
  act(() => {
    getScroller().dispatchEvent(
      new CustomEvent("virtuoso-total-height-change", { detail: { height }, bubbles: true }),
    );
  });
}

/** Give the scroller a viewport box, which picking the gap row to fill measures. */
function stubViewport(el: HTMLElement, height: number): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, right: 100, top: 0, bottom: height, width: 100, height }) as DOMRect;
}

/** The first prompt, a gap of unloaded history, then the latest page. */
const GAP_BLOCKS = [makeBlock("msg-10", "First prompt"), makeBlock("msg-500", "Latest")];
const GAPS = [{ id: "g1", afterId: 10, beforeId: 500 }];
/** Nothing older than the loaded rows is loaded. */
const OPEN_TOP = [{ id: "g0", afterId: null, beforeId: 1 }];

/** Simulate a real wheel-up: wheel listener disengages stick synchronously. */
function userWheelUp(el: HTMLElement, scrollTop: number): void {
  act(() => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true }));
  });
  dispatchScroll(el, scrollTop);
}

describe("AgentSession auto-scroll", () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture ??= vi.fn(() => false);
    Element.prototype.setPointerCapture ??= vi.fn();
    Element.prototype.releasePointerCapture ??= vi.fn();
    vi.clearAllMocks();
  });

  it("shows the auto-scroll chip and scrolls to bottom on click", async () => {
    const user = userEvent.setup();
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
    // It opens the composer's instrument row, ahead of the mode control.
    const row = getAutoScrollButton().closest("[data-composer-instruments]");
    expect(row?.querySelector("button")).toBe(getAutoScrollButton());

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    scroller.scrollTop = 0;

    await user.click(getAutoScrollButton());
    expect(scroller.scrollTop).toBe(600);
  });

  // Rule 2: a real wheel-up disables auto-scroll synchronously, before the
  // next streaming layout effect can re-anchor.
  it("rule 2: wheel-up disables auto-scroll", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");

    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");
  });

  // Regression: wheeling up on a short / empty conversation (content fits
  // in the viewport, nothing to scroll) must NOT disable auto-scroll. The
  // earlier behavior killed stick on the very first idle wheel, so by the
  // time the chat grew past the viewport new tokens landed off-screen.
  it("rule 2: wheel-up does not disable auto-scroll when content fits in the viewport", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    // Content fits — scrollHeight <= clientHeight, no scrolling possible.
    stubGeometry(scroller, 200, 400);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");

    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true }));
    });
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
  });

  // The same rule, one step subtler: the stream always renders a blank
  // `STREAM_BOTTOM_GAP_PX` spacer under the last message, so a conversation that
  // visually fits still overflows by that much. Reading raw `scrollHeight >
  // clientHeight` here would call that scrollable and let an idle wheel-up kill
  // stick — see `canScrollStream`.
  it("rule 2: wheel-up ignores the bottom spacer's overflow", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    // 380px of content in a 400px viewport, plus the 40px spacer.
    stubGeometry(scroller, 420, 400);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");

    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true }));
    });
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
  });

  // Wheel-down (scrolling toward the bottom) must NOT disable.
  it("rule 2: wheel-down does not disable auto-scroll", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 50, bubbles: true }));
    });
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
  });

  // Rule 1: scrolling back into the bottom band re-enables auto-scroll.
  // Virtuoso owns the measurement-aware bottom detection (`atBottomThreshold`)
  // — when the user lands within it, Virtuoso fires `atBottomStateChange(true)`
  // and the hook re-engages stick.
  it("rule 1: returning to the bottom re-enables auto-scroll", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    fireAtBottomChange(true);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
    // The hook also pins to the real bottom when returning there, so any
    // phantom tail space (from `defaultItemHeight` overestimation of
    // unmeasured blocks) is collapsed: scrollHeight − clientHeight.
    expect(scroller.scrollTop).toBe(600);
  });

  // Regression: while stick is already engaged, transient
  // `atBottomStateChange(true)` ticks from measurement settles must NOT
  // re-pin the scroller — that's `followOutput` / `totalListHeightChanged`'s
  // job and double-pinning here would thrash on every settle.
  it("does not re-pin on transient atBottom ticks while stick is engaged", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    scroller.scrollTop = 250;

    fireAtBottomChange(true);
    expect(scroller.scrollTop).toBe(250);
  });

  it("does not re-enable auto-scroll when the prompt is focused", async () => {
    const user = userEvent.setup();
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("textbox"));
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");
  });

  // Rule 3: chip click re-engages follow-mode and scrolls to bottom.
  it("rule 3: chip click re-engages follow-mode and scrolls to bottom", async () => {
    const user = userEvent.setup();
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    await user.click(getAutoScrollButton());
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
    expect(scroller.scrollTop).toBe(600);
  });

  // Headline bug: the last block grows token-by-token. Virtuoso's
  // `followOutput` returns `'auto'` while stick is engaged and re-pins after
  // each data update + measurement settle.
  // The growth observer pins on the list's mutation record (a microtask), to
  // the real bottom: scrollHeight − clientHeight.
  it("re-anchors at the bottom when the last block's content grows in place", async () => {
    const baseProps = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<AgentSession {...baseProps} blocks={[makeBlock("1", "Hello")]} />);

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    scroller.scrollTop = 0;

    rerender(<AgentSession {...baseProps} blocks={[makeBlock("1", "Hello world")]} />);
    await waitFor(() => expect(scroller.scrollTop).toBe(600));
  });

  // Sending a message is an explicit user action — even if the user has
  // scrolled up, they want to see their prompt land at the bottom and the
  // reply stream below it. The send handler re-engages stick and pins.
  it("re-engages auto-scroll and pins to bottom when the user sends a message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => {});
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="idle"
        onSend={onSend}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi there" } });
    await user.click(screen.getByLabelText("Send message"));

    expect(onSend).toHaveBeenCalled();
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
    expect(scroller.scrollTop).toBe(600);
  });

  it("passes the selected Claude profile when sending the next prompt", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => {});
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="idle"
        onSend={onSend}
        onStop={vi.fn()}
        selection={{ providerId: "claude_code", modelId: "opus" }}
        runtimeProvider="claude_code"
        runtimeSessionId="runtime-1"
      />,
    );

    // Session details live in the composer's "…" menu (no chip above the card).
    await user.click(screen.getByRole("button", { name: "More composer actions" }));
    await user.click(await screen.findByLabelText("Profile"));
    await user.click(screen.getByRole("option", { name: /bedrock/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi there" } });
    await user.click(screen.getByLabelText("Send message"));

    expect(onSend).toHaveBeenCalledWith("Hi there", undefined, "bedrock");
  });

  // Embedded Unified Agents cards disable the catalog, so the provider comes
  // from the session's hydrated selection rather than the Claude fallback.
  it.each([
    { providerId: "qa-fake-agent", modelId: "fake-small", profile: undefined },
    { providerId: "claude_code", modelId: "opus", profile: "default" },
  ])(
    "sends profile $profile from a catalog-less $providerId session",
    async ({ providerId, modelId, profile }) => {
      const user = userEvent.setup();
      const onSend = vi.fn(async () => {});
      const coldCatalog = { data: undefined, isLoading: false } as unknown as NonNullable<
        Parameters<typeof AgentSession>[0]["agentCatalog"]
      >;
      render(
        <AgentSession
          agentType="session"
          blocks={[makeBlock("1", "Hello")]}
          status="idle"
          onSend={onSend}
          onStop={vi.fn()}
          agentCatalog={coldCatalog}
          selection={{ providerId, modelId }}
          runtimeProvider={providerId}
        />,
      );

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi there" } });
      await user.click(screen.getByLabelText("Send message"));

      expect(onSend).toHaveBeenCalledWith("Hi there", undefined, profile);
    },
  );

  // On cold-open, item heights start at `defaultItemHeight` (96px) and grow
  // as markdown / code highlighting / async sub-components remeasure. After
  // we land at the bottom once, the total list height keeps growing — the
  // view ends up "almost" at the bottom but a few hundred pixels short. The
  // hook subscribes to Virtuoso's `totalListHeightChanged` and re-pins on
  // every settle step until the list stabilises.
  it("re-pins to bottom while item heights settle on first paint", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    // Initial measurement: tiny list, we're at the bottom.
    stubGeometry(scroller, 500, 400);
    scroller.scrollTop = 100;
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");

    // Markdown / code blocks remeasure and the list grows to 1200: a raw pin
    // to the real bottom, not an index scroll from Virtuoso's size table.
    stubGeometry(scroller, 1200, 400);
    fireTotalHeightChange(1200);
    expect(scroller.scrollTop).toBe(800);

    // A second remeasure pass pushes height further out.
    stubGeometry(scroller, 1800, 400);
    fireTotalHeightChange(1800);
    expect(scroller.scrollTop).toBe(1400);
  });

  // If the user has scrolled away (stick disengaged), an async height
  // settle must NOT yank them back down — that's the whole point of the
  // stick gating.
  it("does not re-pin on height changes when the user has scrolled up", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    stubGeometry(scroller, 1800, 400);
    fireTotalHeightChange(1800);
    expect(scroller.scrollTop).toBe(100);
  });

  // First-paint catch-up: when blocks arrive after AgentSession has mounted
  // (the common case for opening an existing conversation), Virtuoso's
  // `initialTopMostItemIndex` is already past. The hook fires a one-shot
  // `scrollToIndex({ index: 'LAST' })` on the first non-empty paint.
  it("scrolls to the bottom when blocks first arrive after mount", async () => {
    const baseProps = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<AgentSession {...baseProps} blocks={[]} />);

    // Blocks arrive — landing must be at the bottom and chip engaged.
    rerender(
      <AgentSession {...baseProps} blocks={[makeBlock("1", "Hello"), makeBlock("2", "World")]} />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1200, 400);
    // The rows grow: the growth observer pins to the real bottom.
    rerender(
      <AgentSession {...baseProps} blocks={[makeBlock("1", "Hello"), makeBlock("2", "World!")]} />,
    );

    await waitFor(() => expect(scroller.scrollTop).toBe(800));
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
  });

  // Regression: raw browser `scroll` events (whether from a programmatic
  // re-anchor echo or async Virtuoso measurement) must NOT disengage stick.
  // Only synchronous user input (`wheel`/`touchmove` upward) disengages.
  // Bottom-state is owned by Virtuoso's `atBottomStateChange`.
  it("does not disengage stick on a raw scroll event during async measurement settles", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");

    // Simulate Virtuoso settling: content grew from 1000 to 1400, a stale
    // scroll event arrives. Pre-fix this was misread as the user scrolling up.
    stubGeometry(scroller, 1400, 400);
    dispatchScroll(scroller, 600);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
  });

  // Conversely, if the user has scrolled away (rule 2), an in-place content
  // update must NOT yank the view back down — the chip is the only way back.
  it("does not re-anchor when the user has scrolled up", () => {
    const baseProps = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<AgentSession {...baseProps} blocks={[makeBlock("1", "Hello")]} />);

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 50);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    rerender(<AgentSession {...baseProps} blocks={[makeBlock("1", "Hello world")]} />);
    expect(scroller.scrollTop).toBe(50);
  });

  it("fills a gap row once the reader scrolls near it", async () => {
    const onFillHistoryGap = vi.fn(async () => {});
    render(
      <AgentSession
        agentType="session"
        blocks={GAP_BLOCKS}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        historyGaps={GAPS}
        onFillHistoryGap={onFillHistoryGap}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    stubViewport(scroller, 400);
    userWheelUp(scroller, 100);

    await waitFor(() =>
      expect(onFillHistoryGap).toHaveBeenCalledWith("g1", "older", {
        displayMode: { summaryMode: false, compactMode: true },
        shouldContinue: expect.any(Function),
      }),
    );
  });

  it("loads nothing when no history is missing", async () => {
    const onFillHistoryGap = vi.fn(async () => {});
    render(
      <AgentSession
        agentType="session"
        blocks={GAP_BLOCKS}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        historyGaps={[]}
        onFillHistoryGap={onFillHistoryGap}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    stubViewport(scroller, 400);
    userWheelUp(scroller, 100);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onFillHistoryGap).not.toHaveBeenCalled();
    expect(screen.queryByText("Messages not loaded yet")).not.toBeInTheDocument();
  });

  it("shows the gap row loading while its fill is in flight", async () => {
    let resolveLoad: () => void = () => {};
    const onFillHistoryGap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const props = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onFillHistoryGap,
    };
    const { rerender } = render(<AgentSession {...props} blocks={GAP_BLOCKS} historyGaps={GAPS} />);

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    stubViewport(scroller, 400);
    expect(screen.getByText("Messages not loaded yet")).toBeInTheDocument();
    userWheelUp(scroller, 100);
    expect(await screen.findByText("Loading messages…")).toBeInTheDocument();

    // The page closes the gap: its row goes with it.
    rerender(
      <AgentSession
        {...props}
        blocks={[GAP_BLOCKS[0], makeBlock("msg-200", "Middle"), GAP_BLOCKS[1]]}
        historyGaps={[]}
      />,
    );
    act(() => resolveLoad());
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(onFillHistoryGap).toHaveBeenCalledTimes(1);
  });

  // A conversation whose history failed to load reads as empty, but is not a
  // new one: its composer must not offer (nor send with) first-prompt setup.
  it("does not treat a conversation whose history failed to load as a new one", () => {
    const session = createSessionEntry();
    session.persistedLoaded = true;
    session.historyLoadFailure = { message: "database is locked", retrying: false };
    useWsSessionStore.setState({ sessions: { "s-failed": session } });

    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={vi.fn()}
        onStop={vi.fn()}
        wsSessionId="s-failed"
      />,
    );

    expect(screen.getByRole("textbox").getAttribute("placeholder")).toMatch(/^Message the agent/);
    useWsSessionStore.setState({ sessions: {} });
  });

  it("says in the transcript why a gap failed to load and retries it", async () => {
    const onFillHistoryGap = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValue(undefined);
    render(
      <AgentSession
        agentType="session"
        blocks={GAP_BLOCKS}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        historyGaps={GAPS}
        onFillHistoryGap={onFillHistoryGap}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    stubViewport(scroller, 400);
    userWheelUp(scroller, 100);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load these messages");
    expect(alert).toHaveTextContent("database is locked");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onFillHistoryGap).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  // Regression ("jumps when scrolling up"): replaying the offset captured when
  // a history load started snapped a reader who kept scrolling back down once
  // the page landed. The hook must leave the offset alone.
  it("does not snap back to where a history load started after the page lands", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const baseProps = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onFillHistoryGap: onLoadOlder,
    };
    const { rerender } = render(
      <AgentSession {...baseProps} blocks={[makeBlock("msg-1", "Old")]} historyGaps={OPEN_TOP} />,
    );
    const scroller = getScroller();
    // Reading 80px from the top of a 600px-tall list; the wheel disengages stick.
    stubGeometry(scroller, 600, 200);
    stubViewport(scroller, 200);
    userWheelUp(scroller, 80);
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
    // The reader keeps scrolling while the page loads.
    userWheelUp(scroller, 20);

    act(() => resolveLoad());
    stubGeometry(scroller, 1000, 200);
    rerender(
      <AgentSession
        {...baseProps}
        blocks={[makeBlock("0a", ""), makeBlock("0b", ""), makeBlock("msg-1", "Old")]}
        historyGaps={[]}
      />,
    );
    fireTotalHeightChange(1000);
    await act(async () => {
      for (let i = 0; i < 4; i += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    expect(scroller.scrollTop).toBe(20);
  });

  // Conversation switch: the same `AgentSession` instance is reused when the
  // user navigates to a different session (the route only swaps params).
  // Stick state must reset to "engaged" so the new conversation lands at the
  // bottom — without this, a "scrolled up" state from the previous
  // conversation leaks into the next one and the user lands mid-history.
  it("re-engages stick and pins to bottom when the conversation switches", () => {
    const baseProps = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(
      <AgentSession {...baseProps} wsSessionId="A" blocks={[makeBlock("a1", "First")]} />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "false");

    // Switch to a different conversation. The reset effect runs in the same
    // commit as the blocks swap, so the new conversation pins to its bottom.
    stubGeometry(scroller, 800, 400);
    rerender(<AgentSession {...baseProps} wsSessionId="B" blocks={[makeBlock("b1", "Second")]} />);

    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
    expect(scroller.scrollTop).toBe(400);
  });

  // Regression: switching to a shorter conversation triggered raw `scroll`
  // events with a smaller `scrollTop` against the new `scrollHeight`. Pre-fix
  // the direction-aware `onScroll` misread that as the user scrolling up. The
  // current implementation routes bottom-state through Virtuoso's
  // `atBottomStateChange`, so raw scroll events can't disengage stick at all.
  it("does not disengage stick on a raw scroll event during a conversation swap", () => {
    const baseProps = {
      agentType: "session" as const,
      status: "agent" as const,
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(
      <AgentSession {...baseProps} wsSessionId="A" blocks={[makeBlock("a1", "First")]} />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 2000, 400);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");

    stubGeometry(scroller, 500, 400);
    rerender(<AgentSession {...baseProps} wsSessionId="B" blocks={[makeBlock("b1", "Short")]} />);

    // A stale scroll event from the post-swap clamp must NOT disengage stick.
    dispatchScroll(scroller, 100);
    expect(getAutoScrollButton()).toHaveAttribute("aria-pressed", "true");
  });

  it("runs one gap fill at a time however often the reader scrolls", async () => {
    let resolveLoad: () => void = () => {};
    const onFillHistoryGap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(
      <AgentSession
        agentType="session"
        blocks={GAP_BLOCKS}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        historyGaps={GAPS}
        onFillHistoryGap={onFillHistoryGap}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    stubViewport(scroller, 400);
    userWheelUp(scroller, 100);
    await waitFor(() => expect(onFillHistoryGap).toHaveBeenCalledTimes(1));
    userWheelUp(scroller, 80);
    userWheelUp(scroller, 60);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(onFillHistoryGap).toHaveBeenCalledTimes(1);

    act(() => resolveLoad());
  });
});
