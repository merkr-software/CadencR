// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentCards } from "./subagent-cards";

/** An observer the test drives: `report` says which cards are on screen. */
class DrivenObserver {
  static last: DrivenObserver | null = null;
  readonly observed = new Set<Element>();
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    DrivenObserver.last = this;
  }
  get root(): Element | Document | null {
    return this.options.root ?? null;
  }
  observe = (element: Element): void => void this.observed.add(element);
  unobserve = (element: Element): void => void this.observed.delete(element);
  disconnect = (): void => this.observed.clear();
  report(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const original = window.IntersectionObserver;
afterEach(() => {
  window.IntersectionObserver = original;
});

function setup() {
  window.IntersectionObserver = DrivenObserver as unknown as typeof IntersectionObserver;
  const cards = new SubagentCards();
  const scroller = document.createElement("div");
  const listener = vi.fn();
  cards.subscribe(listener);
  const detach = cards.attach({ reveal: () => true, getScroller: () => scroller });
  return { cards, scroller, listener, detach, observer: () => DrivenObserver.last };
}

describe("SubagentCards", () => {
  it("knows which cards are on screen inside the transcript's scroller", () => {
    const { cards, scroller, observer } = setup();
    const card = document.createElement("section");
    cards.track(card, "toolu_a");
    expect(observer()?.root).toBe(scroller);
    observer()?.report(card, true);
    expect([...cards.getVisible()]).toEqual(["toolu_a"]);

    observer()?.report(card, false);
    expect(cards.getVisible().size).toBe(0);
  });

  it("counts a card on screen until the observer has measured it", () => {
    const { cards, listener, observer } = setup();
    const card = document.createElement("section");
    cards.track(card, "toolu_a");
    // No flash of the agent in the list while its card is being measured.
    expect([...cards.getVisible()]).toEqual(["toolu_a"]);
    observer()?.report(card, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forgets a card that unmounts", () => {
    const { cards, observer } = setup();
    const card = document.createElement("section");
    const untrack = cards.track(card, "toolu_a");
    observer()?.report(card, true);
    untrack();
    expect(cards.getVisible().size).toBe(0);
    expect(observer()?.observed.has(card)).toBe(false);
  });

  it("counts nothing on screen and reveals nothing once the transcript detaches", () => {
    const { cards, detach, observer } = setup();
    const card = document.createElement("section");
    cards.track(card, "toolu_a");
    observer()?.report(card, true);
    expect(cards.reveal("toolu_a")).toBe(true);
    detach();
    expect(cards.getVisible().size).toBe(0);
    expect(cards.reveal("toolu_a")).toBe(false);
  });

  it("watches cards that mounted before the transcript attached", () => {
    window.IntersectionObserver = DrivenObserver as unknown as typeof IntersectionObserver;
    const cards = new SubagentCards();
    const card = document.createElement("section");
    cards.track(card, "toolu_a");
    cards.attach({ reveal: () => true, getScroller: () => document.createElement("div") });
    expect(DrivenObserver.last?.observed.has(card)).toBe(true);
  });

  it("watches from the scroller once it is set after the transcript attached", () => {
    window.IntersectionObserver = DrivenObserver as unknown as typeof IntersectionObserver;
    vi.useFakeTimers();
    const cards = new SubagentCards();
    let scroller: HTMLElement | null = null;
    cards.attach({ reveal: () => true, getScroller: () => scroller });
    const card = document.createElement("section");
    cards.track(card, "toolu_a");
    scroller = document.createElement("div");
    vi.advanceTimersToNextFrame();
    expect(DrivenObserver.last?.root).toBe(scroller);
    expect(DrivenObserver.last?.observed.has(card)).toBe(true);
    vi.useRealTimers();
  });
});
