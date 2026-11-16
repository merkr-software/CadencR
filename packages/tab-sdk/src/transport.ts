import { Emitter } from "./emitter.js";
import { PORT_MESSAGE_TYPE } from "./protocol.js";

/**
 * Where a client gets its `MessagePort` from. A source delivers the current
 * port on subscribe (when it has one) and every later port: a new port means
 * the host side was recreated, and the client re-handshakes on it.
 */
export interface PortSource {
  subscribe(listener: (port: MessagePort) => void): () => void;
}

/** The subset of `MessageEvent` the window source reads. */
interface PortMessageEvent {
  data: unknown;
  ports: readonly MessagePort[];
  source: unknown;
}

/** The subset of `Window` the window source needs (a fake works in tests). */
export interface PortWindow {
  addEventListener(type: "message", listener: (event: PortMessageEvent) => void): void;
}

/** Remembers the latest port so late subscribers (a second `connect()`, a
 *  React StrictMode re-mount) still receive it. */
class LatestPortSource implements PortSource {
  private latest: MessagePort | null = null;
  private readonly ports = new Emitter<MessagePort>();

  push(port: MessagePort): void {
    this.latest = port;
    this.ports.emit(port);
  }

  subscribe(listener: (port: MessagePort) => void): () => void {
    const off = this.ports.on(listener);
    if (this.latest) listener(this.latest);
    return off;
  }
}

const windowSources = new WeakMap<PortWindow, LatestPortSource>();

function isPortMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === PORT_MESSAGE_TYPE
  );
}

/**
 * The guest-page source: the preload posts
 * `window.postMessage({ type: "cadencr-tab:port" }, "*", [port])` on every
 * load. Only messages whose `source` is the window itself are accepted.
 * One source per window, shared by every client.
 */
export function windowPortSource(win: PortWindow = globalThis.window): PortSource {
  const existing = windowSources.get(win);
  if (existing) return existing;
  const source = new LatestPortSource();
  win.addEventListener("message", (event) => {
    if (event.source !== win || !isPortMessage(event.data)) return;
    const port = event.ports[0];
    if (port) source.push(port);
  });
  windowSources.set(win, source);
  return source;
}

/** A source that only ever delivers `port`. */
export function singlePortSource(port: MessagePort): PortSource {
  return {
    subscribe(listener) {
      listener(port);
      return () => {};
    },
  };
}

function isMessagePort(value: PortSource | MessagePort): value is MessagePort {
  return typeof (value as MessagePort).postMessage === "function";
}

export function toPortSource(transport: PortSource | MessagePort | undefined): PortSource {
  if (transport === undefined) {
    if (typeof window === "undefined") {
      throw new TypeError("connect() outside a browser needs an explicit `transport`");
    }
    return windowPortSource(window);
  }
  return isMessagePort(transport) ? singlePortSource(transport) : transport;
}

// Listen as soon as the SDK loads: the preload may post the port before the
// app calls `connect()`, and a missed message is never re-sent.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  windowPortSource(window);
}
