// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo, useSyncExternalStore, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useStreamingMarkdownThrottle } from "./useStreamingMarkdownThrottle";

/**
 * Real-scheduler reproduction of the "markdown frozen while streaming" bug: a
 * WebSocket-fed store re-renders the streaming block on the sync lane every
 * few milliseconds while the markdown leaf costs more than the gap between
 * two updates. Under that load the published value must still advance.
 */

type Listener = () => void;

function createTextStore(initial: string) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: (): string => value,
    subscribe: (listener: Listener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    append: (chunk: string): void => {
      value += chunk;
      for (const listener of listeners) listener();
    },
  };
}

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Simulates a markdown parse that outlasts the gap between two deltas.
  }
}

const SlowMarkdown = memo(function SlowMarkdown({ text }: { text: string }): ReactElement {
  busyWait(20);
  return <div data-testid="out">{text}</div>;
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("useStreamingMarkdownThrottle under continuous sync renders", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  const actFlag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let previousActFlag: boolean | undefined;

  beforeEach(() => {
    previousActFlag = actFlag.IS_REACT_ACT_ENVIRONMENT;
    // Drive React's real scheduler: act() would flush transitions eagerly and
    // hide the starvation this test is about.
    actFlag.IS_REACT_ACT_ENVIRONMENT = false;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    host.remove();
    actFlag.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
  });

  it("puts the publish on screen before its timer task returns", () => {
    vi.useFakeTimers();
    try {
      const store = createTextStore("start");
      function StreamingLeaf(): ReactElement {
        const content = useSyncExternalStore(store.subscribe, store.get);
        return <div data-testid="out">{useStreamingMarkdownThrottle(content, true)}</div>;
      }
      root = createRoot(host);
      flushSync(() => root?.render(<StreamingLeaf />));
      flushSync(() => store.append("-more"));
      // The trailing timer fires: its render must already be on screen when
      // the task returns. A deferred (default or transition) publish would
      // still be queued, pending through the next WebSocket sync commit,
      // which is what React's nested-update counter (#185) counts.
      vi.advanceTimersByTime(100);
      expect(host.textContent).toBe("start-more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps publishing the growing content while deltas keep arriving", async () => {
    const store = createTextStore("start");
    function StreamingLeaf(): ReactElement {
      const content = useSyncExternalStore(store.subscribe, store.get);
      const shown = useStreamingMarkdownThrottle(content, true);
      return <SlowMarkdown text={shown} />;
    }
    root = createRoot(host);
    root.render(<StreamingLeaf />);
    await wait(50);
    const rendered = (): string => host.querySelector("[data-testid=out]")?.textContent ?? "";
    expect(rendered()).toBe("start");

    // A delta every 4 ms for ~1.2 s: far shorter than React's 5 s transition
    // expiry, which would otherwise eventually force a commit.
    const ticker = setInterval(() => store.append("x"), 4);
    try {
      await wait(1200);
      const shown = rendered();
      expect(shown.length).toBeGreaterThan("start".length + 20);
      expect(store.get().startsWith(shown)).toBe(true);
    } finally {
      clearInterval(ticker);
    }
  });
});
