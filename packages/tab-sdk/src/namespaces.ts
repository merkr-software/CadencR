import { CadencrError } from "./errors.js";
import type { JsonValue, ToastParams } from "./protocol.js";
import type { Requester } from "./requester.js";
import { createApiResponse, type ApiResponse } from "./response.js";

/** The plugin's own key/value store, per project (≤ 256 KiB per value). */
export interface CadencrStorage {
  /** `null` when the key is missing. */
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | null>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Per-instance state held in host memory (≤ 1 MiB). Survives the guest view
 *  being destroyed and recreated, not an app restart. */
export interface CadencrState {
  get<T extends JsonValue = JsonValue>(): Promise<T | null>;
  set(value: JsonValue): Promise<void>;
}

export interface CadencrConfig {
  /** Non-secret configuration: project values over global over defaults. */
  get(): Promise<Record<string, unknown>>;
}

export interface NetFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | ArrayBufferView;
  timeoutMs?: number;
}

export interface CadencrNet {
  /** Fetch from an origin listed in the manifest's `network.allowed_origins`,
   *  relayed by the service. `{{secret:<key>}}` in header values is replaced
   *  server-side. Non-2xx statuses resolve. */
  fetch(url: string, init?: NetFetchInit): Promise<ApiResponse>;
}

export interface CadencrUi {
  toast(toast: ToastParams): Promise<void>;
  /** Opens an `https:` URL in the user's browser after a host confirmation. */
  openExternal(url: string): Promise<void>;
  /** Up to 4 characters on the tab trigger; `null` clears it. */
  setBadge(text: string | null): Promise<void>;
}

/** The service relay times out at 30 s; leave room for the hop through the host. */
const NET_FETCH_TIMEOUT_MS = 35_000;

function toArrayBuffer(body: NetFetchInit["body"]): ArrayBuffer | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
  if (body instanceof ArrayBuffer) return body;
  const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return view.slice().buffer as ArrayBuffer;
}

/**
 * Runs the writes to one key one after another, in call order. The host relays
 * each write as its own request: two in flight at once could reach storage in
 * either order, leaving the older value stored. Each caller still gets its
 * own write's outcome; the chain only waits for the previous one to settle.
 */
function oneWriteAtATimePerKey(): (key: string, write: () => Promise<void>) => Promise<void> {
  const last = new Map<string, Promise<void>>();
  return (key, write) => {
    const previous = last.get(key);
    const run = previous ? previous.then(write) : write();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    last.set(key, settled);
    void settled.then(() => {
      if (last.get(key) === settled) last.delete(key);
    });
    return run;
  };
}

export function createStorage(send: Requester): CadencrStorage {
  const write = oneWriteAtATimePerKey();
  return {
    get: async <T extends JsonValue>(key: string) =>
      ((await send("storage.get", { key })) ?? null) as T | null,
    set: (key, value) => {
      // Copied now: a queued write saves the value as it was when `set` was
      // called, not as the caller changed it while the write waited.
      let copy: JsonValue;
      try {
        copy = structuredClone(value);
      } catch (error) {
        return Promise.reject(
          new CadencrError("BAD_REQUEST", `storage.set params cannot be sent: ${String(error)}`, {
            cause: error,
          }),
        );
      }
      return write(key, async () => {
        await send("storage.set", { key, value: copy });
      });
    },
    delete: (key) =>
      write(key, async () => {
        await send("storage.delete", { key });
      }),
    list: () => send("storage.list", {}),
  };
}

export function createState(send: Requester): CadencrState {
  return {
    get: async <T extends JsonValue>() => ((await send("state.get", {})) ?? null) as T | null,
    set: async (value) => {
      await send("state.set", { value });
    },
  };
}

export function createConfig(send: Requester): CadencrConfig {
  return { get: () => send("config.get", {}) };
}

export function createNet(send: Requester): CadencrNet {
  return {
    async fetch(url, init = {}) {
      const result = await send(
        "net.fetch",
        {
          url,
          method: init.method,
          headers: init.headers,
          body: toArrayBuffer(init.body),
        },
        init.timeoutMs ?? NET_FETCH_TIMEOUT_MS,
      );
      return createApiResponse(result);
    },
  };
}

export function createUi(send: Requester): CadencrUi {
  return {
    toast: async (toast) => {
      await send("ui.toast", toast);
    },
    openExternal: async (url) => {
      if (!/^https:\/\//i.test(url)) {
        throw new CadencrError("BAD_REQUEST", "ui.openExternal only opens https: URLs");
      }
      await send("ui.openExternal", { url });
    },
    setBadge: async (text) => {
      if (text !== null && [...text].length > 4) {
        throw new CadencrError("BAD_REQUEST", "A tab badge holds at most 4 characters");
      }
      await send("ui.setBadge", { text });
    },
  };
}
