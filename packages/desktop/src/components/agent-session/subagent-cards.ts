/** Scrolls the transcript to a sub-agent's card; false when its card is not loaded. */
export type SubagentRevealer = (toolUseId: string) => boolean;

/** What the mounted transcript lends the bridge. */
export interface SubagentCardsStream {
  reveal: SubagentRevealer;
  /** The transcript's scroller: a card counts as on screen inside it. */
  getScroller: () => HTMLElement | null;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * A card counts as on screen once it shows this far past the scroller's top
 * or bottom edge: a sliver under the fades does not.
 */
const EDGE_MARGIN = "-48px 0px -48px 0px";

/**
 * The bridge between one session's transcript and its composer's agent list:
 * which sub-agent cards are on screen right now (the list leaves those out,
 * they already show) and how to bring one that is not into view.
 *
 * Cards report themselves (`track`) as Virtuoso mounts them; the transcript
 * attaches while mounted. Nothing here re-renders the transcript: the list
 * subscribes to `getVisible`, which changes only when a card enters or
 * leaves the screen. A card the observer has not measured yet counts as on
 * screen, so a list never flashes an agent whose card is about to report in.
 */
export class SubagentCards {
  private stream: SubagentCardsStream | null = null;
  private observer: IntersectionObserver | null = null;
  private readonly tracked = new Map<Element, string>();
  /** Cards the observer last reported inside the scroller. */
  private readonly onScreen = new Set<Element>();
  /** Cards the current observer has not reported on yet. */
  private readonly unmeasured = new Set<Element>();
  private visible: ReadonlySet<string> = NONE;
  private readonly listeners = new Set<() => void>();

  /** Lends the transcript; returns the detach. */
  attach(stream: SubagentCardsStream): () => void {
    this.stream = stream;
    this.observe();
    // The scroller may only be set after this commit (Virtuoso's own effects).
    const frame = requestAnimationFrame(() => {
      if (this.stream === stream && this.rootChanged()) this.observe();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (this.stream !== stream) return;
      this.stream = null;
      this.disconnect();
      this.publish(NONE);
    };
  }

  reveal(toolUseId: string): boolean {
    return this.stream?.reveal(toolUseId) ?? false;
  }

  /** A mounted card; returns the untrack for its unmount. */
  track(element: Element, toolUseId: string): () => void {
    this.tracked.set(element, toolUseId);
    if (this.rootChanged()) this.observe();
    else if (this.observer) {
      this.unmeasured.add(element);
      this.observer.observe(element);
      this.recount();
    }
    return () => {
      this.tracked.delete(element);
      this.onScreen.delete(element);
      this.unmeasured.delete(element);
      this.observer?.unobserve(element);
      this.recount();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVisible = (): ReadonlySet<string> => this.visible;

  private rootChanged(): boolean {
    return (this.stream?.getScroller() ?? null) !== (this.observer?.root ?? null);
  }

  /** (Re)creates the observer on the current scroller and observes every card. */
  private observe(): void {
    this.disconnect();
    const root = this.stream?.getScroller();
    if (!root) {
      this.publish(NONE);
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          this.unmeasured.delete(entry.target);
          if (entry.isIntersecting) this.onScreen.add(entry.target);
          else this.onScreen.delete(entry.target);
        }
        this.recount();
      },
      { root, rootMargin: EDGE_MARGIN },
    );
    for (const element of this.tracked.keys()) {
      this.unmeasured.add(element);
      this.observer.observe(element);
    }
    this.recount();
  }

  private recount(): void {
    if (!this.observer) return;
    const next = new Set<string>();
    for (const element of [...this.onScreen, ...this.unmeasured]) {
      const toolUseId = this.tracked.get(element);
      if (toolUseId !== undefined) next.add(toolUseId);
    }
    this.publish(next);
  }

  private disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.onScreen.clear();
    this.unmeasured.clear();
  }

  private publish(next: ReadonlySet<string>): void {
    const current = this.visible;
    if (next.size === current.size && [...next].every((id) => current.has(id))) return;
    this.visible = next.size === 0 ? NONE : next;
    for (const listener of this.listeners) listener();
  }
}
