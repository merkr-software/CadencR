import { create } from "zustand";
import {
  remoteDisable,
  remoteEnable,
  remoteRevokeDevice,
  remoteSetTunnelHost,
  remoteStatus,
  type RemoteStatus,
} from "@/api/generated";
import { isRemoteStatus } from "@/lib/remote/validate";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { readRemoteHostErrorDetails } from "@/lib/remote/host-errors";

/**
 * Host-side remote-access control state. Loopback-only: these endpoints require
 * the launch token and are never reachable from a remote device.
 *
 * No optimistic updates — every action awaits the backend and commits the
 * `RemoteStatus` the endpoint returns (enable/disable/revoke all echo fresh
 * status). `phase` drives spinners (explicit-state rule); `error` is rendered
 * inline by the dialog, which is always open while these actions run.
 */
export type RemotePhase = "idle" | "loading" | "mutating";

type RemoteFailure =
  | { kind: "malformed" | "request" | "poll" | "bind" | "unpackaged" }
  | { kind: "missingIndex"; path: string }
  | { kind: "detail"; message: string };

function remoteRequestFailure(
  error: unknown,
  fallback: RemoteFailure = { kind: "request" },
): RemoteFailure {
  if (apiErrorCode(error) === "REMOTE_BIND_FAILED") return { kind: "bind" };
  const details = readRemoteHostErrorDetails(error);
  if (details?.code === "REMOTE_RENDERER_DIRECTORY_MISSING") return { kind: "unpackaged" };
  if (details?.code === "REMOTE_RENDERER_INDEX_MISSING") {
    return { kind: "missingIndex", path: details.path };
  }
  const message = apiErrorMessage(error, "");
  return message ? { kind: "detail", message } : fallback;
}

export function remoteFailureMessage(t: UiTranslator, error: RemoteFailure): string {
  switch (error.kind) {
    case "request":
      return t("remote.host.errors.request", "Remote access request failed.");
    case "poll":
      return t("remote.host.errors.poll", "Could not refresh remote access status.");
    case "malformed":
      return t("remote.host.errors.malformed", "Malformed remote status response.");
    case "bind":
      return t(
        "remote.host.errors.bind",
        "could not bind the remote listener (port may be in use)",
      );
    case "unpackaged":
      return t(
        "remote.host.errors.unpacked",
        "Service unavailable: remote access requires a packaged build (no renderer dir)",
      );
    case "missingIndex":
      return t(
        "remote.host.errors.missingIndex",
        "Service unavailable: remote access needs a built frontend: no index.html at {{path}}",
        { path: error.path },
      );
    case "detail":
      return error.message;
  }
}

export function useRemoteError(): string | null {
  const { t } = useUiTranslation();
  const error = useRemoteStore((state) => state.error);
  return error ? remoteFailureMessage(t, error) : null;
}

/** The last action's failure, else the last poll's: what the dialog reports. */
export function useRemoteDialogError(): string | null {
  const { t } = useUiTranslation();
  const error = useRemoteStore((state) => state.error ?? state.pollError);
  return error ? remoteFailureMessage(t, error) : null;
}

interface RemoteState {
  status: RemoteStatus | null;
  /**
   * When the request that produced `status` (or confirmed it unchanged) was
   * sent, on the `performance.now()` clock: a status asked for after an event
   * (a code minted) describes it.
   */
  statusAt: number;
  /** True once at least one successful fetch has populated `status`. */
  loaded: boolean;
  phase: RemotePhase;
  /** The last action's failure, until the next action or `clearError`. */
  error: RemoteFailure | null;
  /** The last poll's failure, until a poll succeeds. */
  pollError: RemoteFailure | null;
  refresh: () => Promise<void>;
  clearError: () => void;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  revokeDevice: (id: number) => Promise<void>;
  /** Set (or clear, with `null`) the tunnel hostname; restarts the listener. */
  setTunnelHost: (host: string | null) => Promise<void>;
}

type SetState = (partial: Partial<RemoteState>) => void;

// Bumped by every status an action writes, so a poll sent before it cannot
// overwrite its newer answer when the poll's response lands last.
let actionWrites = 0;

async function runStatusCall(
  set: SetState,
  phase: Exclude<RemotePhase, "idle">,
  call: () => Promise<unknown>,
): Promise<void> {
  const requestedAt = performance.now();
  set({ phase, error: null });
  try {
    const result = await call();
    if (!isRemoteStatus(result)) {
      set({ phase: "idle", error: { kind: "malformed" } });
      return;
    }
    actionWrites += 1;
    set({ status: result, statusAt: requestedAt, loaded: true, phase: "idle", pollError: null });
  } catch (err) {
    set({ phase: "idle", error: remoteRequestFailure(err) });
  }
}

// Several components (the toolbar button, the dialog, the connected-count poll)
// each call `refresh()` on mount, and StrictMode double-invokes those effects —
// without a guard that fired a burst of identical `GET /api/remote/status`
// requests at startup. Coalesce overlapping refreshes into one in-flight call;
// mutations are intentionally excluded since they must always reach the backend.
let inFlightRefresh: Promise<void> | null = null;

function refreshStatus(set: SetState, get: () => RemoteState): Promise<void> {
  if (inFlightRefresh) return inFlightRefresh;
  const request = get().loaded
    ? pollStatus(set, get)
    : runStatusCall(set, "loading", () => remoteStatus());
  inFlightRefresh = request.finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/**
 * A refresh once status is loaded (the dialog's and the sidebar's polls): it
 * leaves `phase` and an action's `error` alone, so a switch never blinks
 * disabled and an error stays up; its own failure goes to `pollError`, cleared
 * by the next poll that succeeds. It keeps the same `status` object while
 * nothing changed, so a poll re-renders only what reads `statusAt`, and it
 * drops its answer when an action wrote a newer status meanwhile.
 */
async function pollStatus(set: SetState, get: () => RemoteState): Promise<void> {
  const requestedAt = performance.now();
  const writesBefore = actionWrites;
  try {
    const result = await remoteStatus();
    if (!isRemoteStatus(result)) {
      set({ pollError: { kind: "malformed" } });
      return;
    }
    if (actionWrites !== writesBefore) return;
    const unchanged = JSON.stringify(get().status) === JSON.stringify(result);
    set(
      unchanged
        ? { statusAt: requestedAt, pollError: null }
        : { status: result, statusAt: requestedAt, pollError: null },
    );
  } catch (err) {
    set({ pollError: remoteRequestFailure(err, { kind: "poll" }) });
  }
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
  status: null,
  statusAt: 0,
  loaded: false,
  phase: "idle",
  error: null,
  pollError: null,
  refresh: () => refreshStatus(set, get),
  clearError: () => set({ error: null }),
  enable: () => runStatusCall(set, "mutating", () => remoteEnable()),
  disable: () => runStatusCall(set, "mutating", () => remoteDisable()),
  revokeDevice: (id) => runStatusCall(set, "mutating", () => remoteRevokeDevice(id)),
  setTunnelHost: (host) => runStatusCall(set, "mutating", () => remoteSetTunnelHost({ host })),
}));
