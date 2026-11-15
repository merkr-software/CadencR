import type { WebSocketLike } from "@/lib/ws-connection";

interface SentEnvelope {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

/** A plugin socket driven by the test: open it, feed it frames, drop it. */
export class FakePluginSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: SentEnvelope[] = [];
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentEnvelope);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  receive(message: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.emit("close", { code } as CloseEvent);
  }

  lastRequest(): SentEnvelope {
    const request = this.sent.at(-1);
    if (!request) throw new Error("nothing sent");
    return request;
  }

  subscribes(): SentEnvelope[] {
    return this.sent.filter((message) => message.action === "subscribe");
  }

  /** Answer the `subscribe` for `topic` with `serverId`. */
  acceptSubscribe(topic: string, serverId: string): void {
    const request = this.subscribes().find((message) => message.payload.topic === topic);
    if (!request) throw new Error(`no subscribe for ${topic}`);
    this.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "subscribed",
      ref: request.id,
      payload: { subscription_id: serverId },
    });
  }
}
