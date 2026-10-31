/**
 * The server-stamped start of a session's running turn, on this device's clock.
 *
 * `session-status-store` owns the backend value. Application composition
 * installs the lookup so session updates do not import the status store.
 */
type TurnStartResolver = (sessionDbId: number) => number | null;

let resolveTurnStart: TurnStartResolver = () => null;

export function registerTurnStartResolver(resolver: TurnStartResolver): () => void {
  const previous = resolveTurnStart;
  resolveTurnStart = resolver;
  return () => {
    if (resolveTurnStart === resolver) resolveTurnStart = previous;
  };
}

export function serverTurnStartLocalMs(sessionDbId: number | null): number | null {
  return sessionDbId == null ? null : resolveTurnStart(sessionDbId);
}
