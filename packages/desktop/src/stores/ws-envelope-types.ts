import type { SessionEntry, WsSessionStore } from "./ws-session-types";
import type { SessionTransportRegistry } from "./ws-session-transport";

// Types for the store accessors we need

export interface StoreAccessors {
  transport: SessionTransportRegistry;
  get: () => WsSessionStore;
  set: (partial: Partial<WsSessionStore>) => void;
  getSession: (sessionId: string) => SessionEntry;
}
