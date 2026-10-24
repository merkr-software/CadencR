import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CadencrClient } from "./client.js";
import { connect, type ConnectOptions } from "./connect.js";
import { toCadencrError, type CadencrError } from "./errors.js";
import type { JsonValue, StreamTopic, TabContext, ThemeSnapshot } from "./protocol.js";
import type { StreamEvent, SubscribeOptions } from "./streams.js";

const ClientContext = createContext<CadencrClient | null>(null);

type ConnectState =
  | { status: "connecting" }
  | { status: "ready"; client: CadencrClient }
  | { status: "error"; error: CadencrError };

export interface CadencrProviderProps {
  children: ReactNode;
  /** Rendered while connecting. */
  fallback?: ReactNode;
  /** Rendered when the connection fails. Defaults to a plain, theme-aware
   *  "Can't reach Cadencr" message with the error's text and code. */
  errorFallback?: ReactNode | ((error: CadencrError) => ReactNode);
  /** Read once, on mount. */
  connectOptions?: ConnectOptions;
}

/** Connects on mount, closes on unmount, and provides the client to hooks. */
export function CadencrProvider({
  children,
  fallback = null,
  errorFallback,
  connectOptions,
}: CadencrProviderProps): ReactNode {
  const [state, setState] = useState<ConnectState>({ status: "connecting" });
  const options = useRef(connectOptions);

  useEffect(() => {
    let cancelled = false;
    let client: CadencrClient | null = null;
    connect(options.current).then(
      (connected) => {
        if (cancelled) {
          connected.close();
          return;
        }
        client = connected;
        setState({ status: "ready", client: connected });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", error: toCadencrError(error) });
      },
    );
    return () => {
      cancelled = true;
      client?.close();
    };
  }, []);

  if (state.status === "connecting") return fallback;
  if (state.status === "error") {
    if (errorFallback === undefined) return <ConnectFailed error={state.error} />;
    return typeof errorFallback === "function" ? errorFallback(state.error) : errorFallback;
  }
  return <ClientContext.Provider value={state.client}>{children}</ClientContext.Provider>;
}

/**
 * The default `errorFallback`. Dependency-free (no kit, no Tailwind): inline
 * styles read the `--cadencr-*` tokens, with system colors for a page that
 * loads no tokens at all.
 */
function ConnectFailed({ error }: { error: CadencrError }): ReactNode {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        minHeight: "100dvh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 24,
        textAlign: "center",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--cadencr-foreground, CanvasText)",
        background: "var(--cadencr-background, Canvas)",
      }}
    >
      <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Can't reach Cadencr</p>
      <p
        style={{
          margin: 0,
          maxWidth: 384,
          fontSize: 12,
          lineHeight: 1.4,
          color: "var(--cadencr-muted-foreground, GrayText)",
        }}
      >
        {error.message}
      </p>
      <code style={{ fontSize: 11, color: "var(--cadencr-muted-foreground, GrayText)" }}>
        {error.code}
      </code>
    </div>
  );
}

/** The connected client. Must be called under `<CadencrProvider>`. */
export function useCadencr(): CadencrClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useCadencr() must be called inside <CadencrProvider>");
  return client;
}

export function useTabContext(): TabContext {
  const client = useCadencr();
  const subscribe = useCallback((notify: () => void) => client.onContextChange(notify), [client]);
  return useSyncExternalStore(subscribe, () => client.context);
}

export function useTheme(): ThemeSnapshot {
  const client = useCadencr();
  const subscribe = useCallback((notify: () => void) => client.onThemeChange(notify), [client]);
  return useSyncExternalStore(subscribe, () => client.theme);
}

/** Whether the tab is currently shown. */
export function useVisibility(): boolean {
  const client = useCadencr();
  const subscribe = useCallback(
    (notify: () => void) => client.onVisibilityChange(notify),
    [client],
  );
  return useSyncExternalStore(subscribe, () => client.visible);
}

/**
 * Runs `handler` each time the manifest's shortcut `id` is pressed while the
 * tab has focus. `handler` may be an inline closure.
 */
export function useShortcut(id: string, handler: () => void): void {
  const client = useCadencr();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(
    () =>
      client.onShortcut((pressed) => {
        if (pressed === id) latest.current();
      }),
    [client, id],
  );
}

export interface UseStreamOptions extends SubscribeOptions {
  /** `false` keeps the subscription closed. Default `true`. */
  enabled?: boolean;
}

/**
 * Subscribes for the component's lifetime. The subscription is re-opened only
 * when `topic`, `params` (compared as JSON) or `enabled` change; `handler`,
 * `onResync` and `onError` may be inline closures.
 */
export function useStream(
  topic: StreamTopic | (string & {}),
  handler: (event: StreamEvent) => void,
  options: UseStreamOptions = {},
): void {
  const client = useCadencr();
  const latest = useRef({ handler, options });
  useEffect(() => {
    latest.current = { handler, options };
  });
  const paramsKey = JSON.stringify(options.params ?? null);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const subscription = client.streams.subscribe(topic, (event) => latest.current.handler(event), {
      params: JSON.parse(paramsKey) ?? undefined,
      onResync: () => latest.current.options.onResync?.(),
      onError: latest.current.options.onError
        ? (error) => latest.current.options.onError?.(error)
        : undefined,
    });
    return () => subscription.unsubscribe();
  }, [client, topic, paramsKey, enabled]);
}

export interface StorageState<T> {
  value: T;
  loading: boolean;
  error: CadencrError | null;
  /** Writes through to `storage.set`; the value updates optimistically and
   *  rolls back to the stored value if the write fails. */
  set(value: T): Promise<void>;
}

/** One key of the plugin's storage, `initial` until loaded or when missing. */
export function useStorage<T extends JsonValue>(key: string, initial: T): StorageState<T> {
  const client = useCadencr();
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CadencrError | null>(null);
  const initialRef = useRef(initial);
  // What is known about the current key. Each key gets its own, so a write
  // still pending for the previous key never holds back (or overwrites) the
  // new key's value.
  const state = useMemo(() => newKeyState(initialRef.current), [client, key]);
  const keyState = useRef<KeyState<T> | null>(null);
  // Publish only committed keys, before the consumer's layout effects can write.
  // A suspended render must not orphan writes belonging to the visible key.
  useLayoutEffect(() => {
    keyState.current = state;
    return () => {
      keyState.current = null;
    };
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.storage.get<T>(key).then(
      (loaded) => {
        if (cancelled) return;
        // A confirmed write is newer than this read. While one is in flight,
        // the read is only what that write would roll back to.
        if (!state.confirmed) {
          state.stored = loaded ?? initialRef.current;
          if (state.pending === 0) setValue(state.stored);
        }
        setError(null);
        setLoading(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(toCadencrError(failure));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, key, state]);

  const set = useCallback(
    async (next: T) => {
      const current = () => keyState.current === state;
      state.pending += 1;
      setValue(next);
      try {
        // `storage.set` runs one key's writes in call order: the write
        // settling now is the newest one settled.
        await client.storage.set(key, next);
        state.stored = next;
        state.confirmed = true;
        if (current()) setError(null);
      } catch (failure) {
        // Roll back unless a newer `set` (or another key) replaced the value meanwhile.
        if (current()) setValue((shown) => (shown === next ? state.stored : shown));
        const cadencrError = toCadencrError(failure);
        if (current()) setError(cadencrError);
        throw cadencrError;
      } finally {
        state.pending -= 1;
      }
    },
    [client, key, state],
  );

  return { value, loading, error, set };
}

/** Per key: the last value known to be stored (a failed `set` rolls back to
 *  it), writes in flight, and whether one was confirmed. */
interface KeyState<T> {
  stored: T;
  pending: number;
  confirmed: boolean;
}

function newKeyState<T>(initial: T): KeyState<T> {
  return { stored: initial, pending: 0, confirmed: false };
}
