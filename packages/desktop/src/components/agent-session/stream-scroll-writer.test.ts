// @vitest-environment happy-dom
import type { VirtuosoHandle } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamScrollWriter, streamScrollWriterFor } from "./stream-scroll-writer";

const isIosMock = vi.fn(() => false);
vi.mock("@/lib/is-ios", () => ({ isIos: () => isIosMock() }));

function scrollerWith({ scrollTop = 0, scrollHeight = 2000, clientHeight = 400 } = {}) {
  const scroller = document.createElement("div");
  const writes: number[] = [];
  let top = scrollTop;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      writes.push(next);
      top = next;
    },
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => clientHeight });
  return { scroller, writes };
}

function ownedWriter(following: boolean) {
  const owner = { following, prepareJump: vi.fn() };
  owner.prepareJump.mockImplementation(() => {
    owner.following = false;
  });
  const writer = new StreamScrollWriter({
    isFollowing: () => owner.following,
    prepareJump: owner.prepareJump,
  });
  return { writer, owner };
}

describe("StreamScrollWriter", () => {
  beforeEach(() => isIosMock.mockReturnValue(false));
  afterEach(() => vi.restoreAllMocks());

  it("pins to the bottom only while bottom-stick holds, and only when not there yet", () => {
    const { scroller, writes } = scrollerWith({ scrollTop: 100 });
    const { writer, owner } = ownedWriter(true);
    writer.attach(scroller);

    expect(writer.pinToBottom()).toBe(true);
    expect(writer.pinToBottom()).toBe(false);
    expect(writes).toEqual([1600]);

    owner.following = false;
    scroller.scrollTop = 0;
    expect(writer.pinToBottom()).toBe(false);
    expect(writes).toEqual([1600, 0]);
  });

  it("never writes raw follow, anchor or jump offsets on iOS; a search reveal still lands", () => {
    isIosMock.mockReturnValue(true);
    const { scroller, writes } = scrollerWith({ scrollTop: 100 });
    const { writer } = ownedWriter(true);
    writer.attach(scroller);

    expect(writer.pinToBottom()).toBe(false);
    expect(writer.scrollBy("keep-anchor", 40)).toBe(false);
    expect(writer.scrollBy("jump", 40)).toBe(false);
    expect(writer.glideTo(500)).toBe(false);
    expect(writes).toEqual([]);

    expect(writer.scrollBy("reveal", 40)).toBe(true);
    expect(writes).toEqual([140]);
  });

  it("releases bottom-stick before a jump or reveal moves the view", () => {
    const { scroller } = scrollerWith({ scrollTop: 1600 });
    const { writer, owner } = ownedWriter(true);
    writer.attach(scroller);

    writer.scrollBy("reveal", -300);
    expect(owner.prepareJump).toHaveBeenCalledTimes(1);
    // The next streamed chunk's pin no longer pulls the match away.
    expect(writer.pinToBottom()).toBe(false);
    expect(scroller.scrollTop).toBe(1300);

    const virtuoso = { scrollToIndex: vi.fn() } as unknown as VirtuosoHandle;
    owner.following = true;
    writer.scrollToIndex(virtuoso, "jump", { index: 3, align: "start" });
    expect(owner.prepareJump).toHaveBeenCalledTimes(2);
    expect(virtuoso.scrollToIndex).toHaveBeenCalledWith({ index: 3, align: "start" });
  });

  it("keeps anchor compensation from touching bottom-stick", () => {
    const { scroller, writes } = scrollerWith({ scrollTop: 500 });
    const { writer, owner } = ownedWriter(true);
    writer.attach(scroller);

    expect(writer.scrollBy("keep-anchor", 25)).toBe(true);
    expect(writes).toEqual([525]);
    expect(owner.prepareJump).not.toHaveBeenCalled();
  });

  it("refuses a bottom index scroll once the reader has left the bottom", () => {
    const { scroller } = scrollerWith();
    const { writer } = ownedWriter(false);
    writer.attach(scroller);
    const virtuoso = { scrollToIndex: vi.fn() } as unknown as VirtuosoHandle;

    expect(writer.scrollToIndex(virtuoso, "follow-bottom", { index: "LAST", align: "end" })).toBe(
      false,
    );
    expect(virtuoso.scrollToIndex).not.toHaveBeenCalled();
  });

  it("hands Virtuoso's scrollBy to the arbiter, natively when it declines", () => {
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    const { scroller } = scrollerWith();
    const writer = new StreamScrollWriter();
    writer.attach(scroller);
    const arbiter = vi.fn((top: number) => top > 0);
    writer.setCompensationArbiter(arbiter);

    scroller.scrollBy({ top: 30 });
    scroller.scrollBy(0, -20);
    expect(arbiter.mock.calls).toEqual([[30], [-20]]);
    expect(native).toHaveBeenCalledTimes(1);

    writer.detach();
    expect(Object.hasOwn(scroller, "scrollBy")).toBe(false);
  });

  it("is found from the scroller element, and a detached one shadows nothing", () => {
    const { scroller } = scrollerWith();
    const { writer } = ownedWriter(false);
    writer.attach(scroller);
    expect(streamScrollWriterFor(scroller)).toBe(writer);
    writer.detach();

    const detached = streamScrollWriterFor(scroller);
    expect(detached).not.toBe(writer);
    expect(Object.hasOwn(scroller, "scrollBy")).toBe(false);
    expect(detached.scrollBy("jump", 10)).toBe(true);
  });

  it("leaves the attached writer's scrollBy in place when a detached one lets go", () => {
    const { scroller } = scrollerWith();
    const { writer } = ownedWriter(false);
    const stray = new StreamScrollWriter(undefined, scroller);
    writer.attach(scroller);
    stray.detach();
    expect(Object.hasOwn(scroller, "scrollBy")).toBe(true);
    expect(streamScrollWriterFor(scroller)).toBe(writer);
    writer.detach();
  });
});
