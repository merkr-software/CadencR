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
  | { kind: "malformed" | "request" | "bind" | "unpackaged" }
  | { kind: "missingIndex"; path: string }
  | { kind: "detail"; message: string };

function remoteRequestFailure(error: unknown): RemoteFailure {
  if (apiErrorCode(error) === "REMOTE_BIND_FAILED") return { kind: "bind" };
  const details = readRemoteHostErrorDetails(error);
  if (details?.code === "REMOTE_RENDERER_DIRECTORY_MISSING") return { kind: "unpackaged" };
  if (details?.code === "REMOTE_RENDERER_INDEX_MISSING") {
    return { kind: "missingIndex", path: details.path };
  }
  const message = apiErrorMessage(error, "");
  return message ? { kind: "detail", message } : { kind: "request" };
}

export function remoteFailureMessage(t: UiTranslator, error: RemoteFailure): string {
  switch (error.kind) {
    case "request":
      return t("remote.host.errors.request", "Remote access request failed.");
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

interface RemoteState {
  status: RemoteStatus | null;
  /** True once at least one successful fetch has populated `status`. */
  loaded: boolean;
  phase: RemotePhase;
  error: RemoteFailure | null;
  refresh: () => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  revokeDevice: (id: number) => Promise<void>;
  /** Set (or clear, with `null`) the tunnel hostname; restarts the listener. */
  setTunnelHost: (host: string | null) => Promise<void>;
}

type SetState = (partial: Partial<RemoteState>) => void;

async function runStatusCall(
  set: SetState,
  phase: Exclude<RemotePhase, "idle">,
  call: () => Promise<unknown>,
): Promise<void> {
  set({ phase, error: null });
  try {
    const result = await call();
    if (!isRemoteStatus(result)) {
      set({ phase: "idle", error: { kind: "malformed" } });
      return;
    }
    set({ status: result, loaded: true, phase: "idle" });
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

function refreshStatus(set: SetState): Promise<void> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = runStatusCall(set, "loading", () => remoteStatus()).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

export const useRemoteStore = create<RemoteState>((set) => ({
  status: null,
  loaded: false,
  phase: "idle",
  error: null,
  refresh: () => refreshStatus(set),
  enable: () => runStatusCall(set, "mutating", () => remoteEnable()),
  disable: () => runStatusCall(set, "mutating", () => remoteDisable()),
  revokeDevice: (id) => runStatusCall(set, "mutating", () => remoteRevokeDevice(id)),
  setTunnelHost: (host) => runStatusCall(set, "mutating", () => remoteSetTunnelHost({ host })),
}));
