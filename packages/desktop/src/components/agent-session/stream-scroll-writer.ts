import type { FlatIndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import { isIos } from "@/lib/is-ios";
import { pinToBottom } from "@/lib/scroll-pin";

/**
 * Why the agent stream's scroll position is being moved.
 *
 * - `follow-bottom`: keep the newest output in view while bottom-stick holds.
 * - `keep-anchor`: absorb height drift above the reader, so what they read
 *   stays put (`ScrollAnchorGuard`). The view does not visibly move.
 * - `jump`: bring a message to the top (prompt rail, composer's agent list).
 * - `reveal`: bring a search match into view.
 */
export type StreamScrollIntent = "follow-bottom" | "keep-anchor" | "jump" | "reveal";

/**
 * Raw `scrollTop` writes allowed on iOS. Virtuoso corrects position there
 * through a CSS "deviation" offset, not a direct scroll; a raw write during
 * momentum scrolling fights it and can loop forever (React #185 in the PWA).
 * `followOutput` keeps iOS pinned, and index scrolls go through Virtuoso,
 * which knows its own deviation. A search reveal is one write on a reader's
 * explicit request, never inside momentum, as before this module existed.
 */
const RAW_WRITE_ON_IOS: Readonly<Record<StreamScrollIntent, boolean>> = {
  "follow-bottom": false,
  "keep-anchor": false,
  jump: false,
  reveal: true,
};

/**
 * Decides what to do with Virtuoso's own resize/prepend compensation, which
 * reaches the scroller only through `scrollBy`. Returns false to let the
 * native `scrollBy` run unchanged.
 */
export type ScrollCompensationArbiter = (requestedTop: number) => boolean;

interface StreamScrollOwner {
  /** Bottom-stick engaged: only then may `follow-bottom` write. */
  isFollowing: () => boolean;
  /** Releases bottom-stick and the anchor guard before a jump or reveal moves the view. */
  prepareJump: () => void;
}

const DETACHED_OWNER: StreamScrollOwner = { isFollowing: () => false, prepareJump: () => {} };

const writers = new WeakMap<HTMLElement, StreamScrollWriter>();

/** The vertical component of a `scrollBy` call, in either of its signatures. */
function scrollByTop(args: unknown[]): number {
  const [first, second] = args;
  if (typeof first === "number") return typeof second === "number" ? second : 0;
  if (typeof first !== "object" || first === null) return 0;
  const { top } = first as ScrollToOptions;
  return typeof top === "number" ? top : 0;
}

/**
 * The one place that moves the agent stream's scroll position. Every write
 * names its intent, so the platform and ownership rules live here instead of
 * at each call site: bottom pinning only while bottom-stick holds and never as
 * a raw write on iOS, anchor compensation never on iOS, a jump or reveal
 * releasing bottom-stick before it moves the view (otherwise the next streamed
 * chunk pins it straight back). Virtuoso's own `scrollBy` compensation is
 * intercepted here and handed to the arbiter the anchor guard registers.
 */
export class StreamScrollWriter {
  private arbiter: ScrollCompensationArbiter | null = null;

  constructor(
    private readonly owner: StreamScrollOwner = DETACHED_OWNER,
    /** Set by `attach`; given directly only to a detached writer. */
    private scroller: HTMLElement | null = null,
  ) {}

  attach(scroller: HTMLElement): void {
    this.detach();
    this.scroller = scroller;
    writers.set(scroller, this);
    // Virtuoso compensates resizes and prepends through `scrollBy` only; an
    // own property shadows the prototype method. iOS keeps Virtuoso's
    // deviation-based correction untouched: no anchor guard runs there.
    if (isIos()) return;
    Object.defineProperty(scroller, "scrollBy", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): void => this.virtuosoScrollBy(scroller, args),
    });
  }

  detach(): void {
    const scroller = this.scroller;
    if (!scroller) return;
    // Only the writer attached to the scroller owns its `scrollBy` shadow; a
    // detached writer (`streamScrollWriterFor`) never installed one.
    if (writers.get(scroller) === this) {
      Reflect.deleteProperty(scroller, "scrollBy");
      writers.delete(scroller);
    }
    this.scroller = null;
    this.arbiter = null;
  }

  /** Routes Virtuoso's `scrollBy` compensation through the anchor guard. */
  setCompensationArbiter(arbiter: ScrollCompensationArbiter | null): void {
    this.arbiter = arbiter;
  }

  /** Whether a raw write of this intent may happen now. */
  canWrite(intent: StreamScrollIntent): boolean {
    if (!this.scroller) return false;
    if (isIos() && !RAW_WRITE_ON_IOS[intent]) return false;
    return intent !== "follow-bottom" || this.owner.isFollowing();
  }

  /** Scroll to the bottom while bottom-stick holds; idempotent (see `pinToBottom`). */
  pinToBottom(): boolean {
    const scroller = this.scroller;
    if (!scroller || !this.canWrite("follow-bottom")) return false;
    return pinToBottom(scroller);
  }

  /** Moves the offset by `delta` px. Returns whether it wrote. */
  scrollBy(intent: Exclude<StreamScrollIntent, "follow-bottom">, delta: number): boolean {
    const scroller = this.scroller;
    if (!scroller || delta === 0 || !this.canWrite(intent)) return false;
    this.takeViewport(intent);
    scroller.scrollTop += delta;
    return true;
  }

  /** Glides to `top` (a nearby jump target). Returns whether it started. */
  glideTo(top: number): boolean {
    const scroller = this.scroller;
    if (!scroller || !this.canWrite("jump")) return false;
    this.takeViewport("jump");
    scroller.scrollTo({ top, behavior: "smooth" });
    return true;
  }

  /** An index scroll through Virtuoso, which owns its platform corrections. */
  scrollToIndex(
    virtuoso: VirtuosoHandle | null,
    intent: StreamScrollIntent,
    location: FlatIndexLocationWithAlign,
  ): boolean {
    if (!virtuoso) return false;
    if (intent === "follow-bottom" && !this.owner.isFollowing()) return false;
    this.takeViewport(intent);
    virtuoso.scrollToIndex(location);
    return true;
  }

  /** A jump or reveal moves the view away from the bottom: follow lets go first. */
  private takeViewport(intent: StreamScrollIntent): void {
    if ((intent === "jump" || intent === "reveal") && this.owner.isFollowing()) {
      this.owner.prepareJump();
    }
  }

  private virtuosoScrollBy(scroller: HTMLElement, args: unknown[]): void {
    if (this.arbiter?.(scrollByTop(args))) return;
    Reflect.apply(Element.prototype.scrollBy, scroller, args);
  }
}

/**
 * The writer attached to a stream scroller, for code that only holds the
 * element (search, prompt rail). A scroller nobody attached gets a detached
 * writer: the same rules, with no bottom-stick to follow or release.
 */
export function streamScrollWriterFor(scroller: HTMLElement): StreamScrollWriter {
  return writers.get(scroller) ?? new StreamScrollWriter(DETACHED_OWNER, scroller);
}
