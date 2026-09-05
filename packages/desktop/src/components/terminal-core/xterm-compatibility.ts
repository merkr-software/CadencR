import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type {
  TerminalEvent,
  TerminalEventMap,
  TerminalOptions,
  TerminalTransport,
} from "celeritty";
import type { TerminalEngine } from "./terminal-engine";

/** Keep unsupported GPUs/browsers usable without loading xterm on the WebGPU path. */
export class XtermCompatibility implements TerminalEngine {
  readonly ready = Promise.resolve();
  private readonly term: Xterm;
  private readonly fit = new FitAddon();
  private readonly observer: ResizeObserver;
  private readonly listeners = new Map<TerminalEvent, Set<(payload: unknown) => void>>();
  private readonly encoder = new TextEncoder();
  private subscriptions: Array<() => void> = [];
  private currentTransport: TerminalTransport | undefined;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    options: TerminalOptions,
  ) {
    this.term = new Xterm({
      scrollback: options.scrollback,
      allowProposedApi: false,
      allowTransparency: true,
      macOptionIsMeta: true,
      fontWeightBold: "600",
      cursorWidth: 2,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(
      new WebLinksAddon(
        (event, url) => {
          this.emit("link-activate", {
            url,
            modifiers: {
              ctrl: event.ctrlKey,
              meta: event.metaKey,
              alt: event.altKey,
              shift: event.shiftKey,
            },
          });
        },
        {
          hover: (_event, url) => this.emit("link-hover", url),
          leave: () => this.emit("link-hover", null),
        },
      ),
    );
    this.setOptions(options);
    this.term.open(host);
    this.term.onData((data) => this.emit("data", this.encoder.encode(data)));
    this.term.onResize(({ cols, rows }) => this.emit("resize", { columns: cols, lines: rows }));
    this.term.onSelectionChange(() => this.emit("selection-change", this.getSelection()));
    this.observer = new ResizeObserver(() => {
      try {
        this.fitToHost();
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.observer.observe(host);
    this.fitToHost();
  }

  on<E extends TerminalEvent>(
    event: E,
    listener: (payload: TerminalEventMap[E]) => void,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    this.listeners.set(event, listeners);
    const callback = (payload: unknown): void => listener(payload as TerminalEventMap[E]);
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  private emit<E extends TerminalEvent>(event: E, payload: TerminalEventMap[E]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  get transport(): TerminalTransport | undefined {
    return this.currentTransport;
  }

  attach(transport: TerminalTransport): void {
    if (this.disposed) throw new Error("Terminal has been disposed");
    this.detach();
    this.currentTransport = transport;
    const subscriptions = this.subscriptions;
    const subscribe = (unsubscribe: () => void): void => {
      if (this.subscriptions === subscriptions) subscriptions.push(unsubscribe);
      else unsubscribe();
    };
    // A transport may synchronously replay output or report that it is closed.
    // Install outbound parser replies first and clean up a closed attachment.
    subscribe(this.on("data", (bytes) => transport.write(bytes)));
    subscribe(this.on("resize", ({ columns, lines }) => transport.resize(columns, lines)));
    subscribe(transport.onData((bytes) => this.feed(bytes)));
    subscribe(
      transport.onClose((reason) => {
        if (this.subscriptions !== subscriptions) return;
        this.detach();
        if (reason) this.emit("error", new Error(reason));
      }),
    );
    if (this.subscriptions === subscriptions && this.hasHostSize) {
      transport.resize(this.term.cols, this.term.rows);
    }
  }

  detach(): void {
    const subscriptions = this.subscriptions;
    this.subscriptions = [];
    this.currentTransport = undefined;
    for (const unsubscribe of subscriptions) unsubscribe();
  }

  private fitToHost(): void {
    if (!this.disposed && this.hasHostSize) this.fit.fit();
  }

  private get hasHostSize(): boolean {
    return this.host.clientWidth > 0 && this.host.clientHeight > 0;
  }

  setOptions(patch: Partial<TerminalOptions>): void {
    if (patch.font) {
      this.term.options.fontFamily = patch.font.family;
      this.term.options.fontSize = patch.font.size;
      this.term.options.lineHeight = Math.max(1, patch.font.lineHeight ?? 1.2);
    }
    if (patch.colors) this.term.options.theme = patch.colors;
    if (patch.cursor) {
      this.term.options.cursorStyle = patch.cursor.style === "beam" ? "bar" : patch.cursor.style;
      this.term.options.cursorBlink = patch.cursor.blink;
    }
    if (patch.scrollback !== undefined) this.term.options.scrollback = patch.scrollback;
    if (this.term.element) this.fitToHost();
  }

  feed(bytes: Uint8Array): void {
    this.term.write(bytes);
  }
  write(text: string): void {
    this.term.write(text);
  }
  focus(): void {
    this.term.focus();
  }
  blur(): void {
    this.term.blur();
  }
  clearScreen(): void {
    this.term.write("\x1b[2J\x1b[H");
  }
  scrollLines(delta: number): void {
    this.term.scrollLines(delta);
  }
  scrollToBottom(): void {
    this.term.scrollToBottom();
  }
  getSelection(): string | null {
    return this.term.getSelection() || null;
  }
  async copySelection(): Promise<void> {
    const selection = this.getSelection();
    if (selection) await navigator.clipboard.writeText(selection);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.observer.disconnect();
    this.listeners.clear();
    this.term.dispose();
  }
}
