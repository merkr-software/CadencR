import type {
  TerminalEvent,
  TerminalEventMap,
  TerminalOptions,
  TerminalTransport,
} from "celeritty";

/** Only the engine capabilities consumed by Cadencr, not the upstream class surface. */
export interface TerminalEngine {
  readonly ready: Promise<void>;
  readonly transport: TerminalTransport | undefined;
  on<E extends TerminalEvent>(
    event: E,
    listener: (payload: TerminalEventMap[E]) => void,
  ): () => void;
  attach(transport: TerminalTransport): void;
  detach(): void;
  setOptions(patch: Partial<TerminalOptions>): void;
  write(text: string): void;
  focus(): void;
  blur(): void;
  clearScreen(): void;
  scrollLines(delta: number): void;
  scrollToBottom(): void;
  getSelection(): string | null;
  copySelection(): Promise<void>;
  dispose(): void;
}
