import { describe, it, expect, vi, beforeEach } from "vitest";
import { forwardRef, useImperativeHandle, useRef, useState, type ForwardedRef } from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";
import { AgentSession } from "./AgentSession";
import type { AgentBlockData } from "../AgentBlock";
import { toast } from "sonner";

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

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
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

/** Simulate a real wheel-up: wheel listener disengages stick synchronously. */

function fireStartReached(): void {
  act(() => {
    getScroller().dispatchEvent(new Event("virtuoso-start-reached", { bubbles: true }));
  });
}

function userWheelUp(el: HTMLElement, scrollTop: number): void {
  act(() => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true }));
  });
  dispatchScroll(el, scrollTop);
}

const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * Drive the shared "user scrolls to the top from 80px, a page of older
 * history loads, then Virtuoso reports the taller remeasured height" flow used
 * by both prepend-anchoring tests. Returns the scroller so each test asserts
 * only the behaviour that differs (desktop compensates scrollTop; iOS leaves
 * it alone).
 */
function loadOlderHistoryPage(): HTMLElement {
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
    hasMore: true,
    onLoadOlder,
  };

  const { rerender } = render(<AgentSession {...baseProps} blocks={[makeBlock("1", "Old")]} />);
  const scroller = getScroller();
  // Reading 80px from the top of a 600px-tall list. WheelUp also disengages
  // stick so the layout effect doesn't pull us back to the bottom.
  stubGeometry(scroller, 600, 200);
  userWheelUp(scroller, 80);

  fireStartReached();
  expect(onLoadOlder).toHaveBeenCalledTimes(1);

  // Older blocks land at the front; once resolved, Virtuoso reports the taller
  // total height via `totalListHeightChanged`.
  act(() => resolveLoad());
  stubGeometry(scroller, 1000, 200);
  rerender(
    <AgentSession
      {...baseProps}
      blocks={[makeBlock("0a", ""), makeBlock("0b", ""), makeBlock("1", "Old")]}
    />,
  );
  fireTotalHeightChange(1000);
  return scroller;
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

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    scroller.scrollTop = 0;

    await user.click(getAutoScrollButton());
    expect(scroller.scrollTop).toBe(1000);
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
    // The hook also clamps to the true last item when returning to bottom,
    // so any phantom tail space (from `defaultItemHeight` overestimation of
    // unmeasured blocks) is collapsed — the scroller lands at scrollHeight.
    expect(scroller.scrollTop).toBe(1000);
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
    expect(scroller.scrollTop).toBe(1000);
  });

  // Headline bug: the last block grows token-by-token. Virtuoso's
  // `followOutput` returns `'auto'` while stick is engaged and re-pins after
  // each data update + measurement settle.
  it("re-anchors at the bottom when the last block's content grows in place", () => {
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
    expect(scroller.scrollTop).toBe(1000);
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
    expect(scroller.scrollTop).toBe(1000);
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
        currentProviderId="claude_code"
        runtimeProvider="claude_code"
        runtimeSessionId="runtime-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Session info" }));
    await user.click(screen.getByLabelText("Claude profile"));
    await user.click(screen.getByRole("option", { name: /bedrock/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi there" } });
    await user.click(screen.getByLabelText("Send message"));

    expect(onSend).toHaveBeenCalledWith("Hi there", undefined, "bedrock");
  });

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

    // Markdown / code blocks remeasure and the list grows to 1200.
    stubGeometry(scroller, 1200, 400);
    fireTotalHeightChange(1200);
    expect(scroller.scrollTop).toBe(1200);

    // A second remeasure pass pushes height further out.
    stubGeometry(scroller, 1800, 400);
    fireTotalHeightChange(1800);
    expect(scroller.scrollTop).toBe(1800);
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
  it("scrolls to the bottom when blocks first arrive after mount", () => {
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
    // Trigger the first-paint scroll path (mock pins to bottom).
    rerender(
      <AgentSession {...baseProps} blocks={[makeBlock("1", "Hello"), makeBlock("2", "World!")]} />,
    );

    expect(scroller.scrollTop).toBe(1200);
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

  it("does not auto-load older history from an initial top signal", () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    );

    stubGeometry(getScroller(), 1000, 400);
    fireStartReached();

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("loads older history after the user scrolls upward to the first item", async () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    fireStartReached();

    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
  });

  it("does not call onLoadOlder when there is no more history", () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        hasMore={false}
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    fireStartReached();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("shows the loading-older spinner while a fetch is in flight", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const { container } = render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();

    fireStartReached();
    await waitFor(() => {
      expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    });

    act(() => resolveLoad());
    await waitFor(() => {
      expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    });
  });

  it("shows a toast when loading older history fails", async () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        hasMore
        onLoadOlder={vi.fn(async () => {
          throw new Error("boom");
        })}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    fireStartReached();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to load older messages"));
  });

  // Prepend anchoring starts with Virtuoso's `firstItemIndex`, but the first
  // pass only knows estimated item heights. Once the prepended rows measure,
  // the hook compensates by the actual scrollHeight delta so the previously
  // visible content stays anchored instead of jumping upward into the newly
  // loaded history.
  it("compensates scrollTop by the measured height delta after older messages are prepended", async () => {
    // Older blocks land at the front. The hook leaves scrollTop alone until
    // Virtuoso reports the measured total height, then preserves the previous
    // visual anchor by adding the measured scrollHeight delta (200 → 1000 over
    // a viewport of 200, so 80 + 400).
    const scroller = loadOlderHistoryPage();
    await waitFor(() => expect(scroller.scrollTop).toBe(480));
  });

  // iOS regression (remote SPA on Safari): momentum scrolling keeps moving
  // the viewport after the history request captures its anchor, and Virtuoso
  // itself defers upward-resize compensation into a CSS deviation until the
  // scroll settles. Replaying the stale absolute anchor snapped the view back
  // *down* while the user was scrolling up. On iOS the hook must leave
  // scrollTop alone and let Virtuoso's `firstItemIndex` anchoring own the
  // prepend.
  it("does not rewrite scrollTop after older messages are prepended on iOS", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: IPHONE_USER_AGENT,
    });
    try {
      const scroller = loadOlderHistoryPage();
      // Flush the scheduled restore frames (the hook schedules 3 rAF passes
      // plus a settle timeout) — none of them may touch scrollTop on iOS.
      await act(async () => {
        for (let i = 0; i < 4; i += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
      expect(scroller.scrollTop).toBe(80);
    } finally {
      Reflect.deleteProperty(navigator, "userAgent");
    }
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
    expect(scroller.scrollTop).toBe(800);
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

  it("collapses concurrent intersection fires while a load is in flight", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Hello")]}
        status="agent"
        onSend={vi.fn()}
        onStop={vi.fn()}
        hasMore
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = getScroller();
    stubGeometry(scroller, 1000, 400);
    userWheelUp(scroller, 100);
    fireStartReached();
    fireStartReached();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    act(() => resolveLoad());
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
  });
});
