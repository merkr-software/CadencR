import type { SocketLike } from "./broker-streams";

interface SentEnvelope {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

/** A plugin socket driven by the test: open it, feed it frames, drop it. */
export class FakePluginSocket implements SocketLike {
  readyState = 0;
  readonly sent: SentEnvelope[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentEnvelope);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
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
