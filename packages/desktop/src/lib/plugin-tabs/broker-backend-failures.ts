import type { HostReportedBackendCode } from "@cadencr/tab-sdk";
import { toast } from "sonner";

import { reasonClause } from "@/components/plugin-tabs/plugin-tab-access";
import { capitalize } from "@/lib/utils";

import { toBrokerError } from "./broker-errors";
import { setPluginTabActivityOpen } from "./runtime-store";

/**
 * Backend failures the host tells the user about (docs/TAB_BACKEND_PROTOCOL.md):
 * the ones that keep the backend from running at all, which no retry by the
 * tab's page fixes. Anything else `backend.request` rejects with — a timeout,
 * a busy or exited backend, the backend's own method errors — stays the
 * page's to handle. The codes are the SDK's `HOST_REPORTED_BACKEND_CODES`
 * (pages skip them with `isReportedByHost`); the record type keeps both
 * lists identical.
 */
interface SurfacedCopy {
  title: string;
  restart: boolean;
  /** What the user can do about it, after the service's explanation. */
  advice?: string;
  /**
   * Said instead of the service's explanation when that one names full paths:
   * a toast stays short, and the tab's Activity log has the details.
   */
  summary?: string;
}

const SURFACED_COPY: Readonly<Record<HostReportedBackendCode, SurfacedCopy>> = {
  PLUGIN_BACKEND_NOT_NATIVE: { title: "its backend is not a native executable", restart: false },
  PLUGIN_BACKEND_UNSIGNED: { title: "its backend is not code-signed", restart: false },
  PLUGIN_BACKEND_UNAVAILABLE: { title: "its backend can't start", restart: false },
  PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM: {
    title: "its backend has no build for this platform",
    restart: false,
  },
  PLUGIN_BACKEND_TAMPERED: {
    title: "its backend binary was modified after install",
    restart: false,
    summary: "It differs from the binary its signed package names; its Activity shows which file.",
    advice: "Reinstall or update the tab from the Marketplace.",
  },
  // Backend starts need a current revocation list; the page itself keeps working.
  MANAGED_TAB_POLICY_UNAVAILABLE: {
    title: "Cadencr couldn't confirm it is still allowed to run native code",
    restart: false,
    advice: "Check your connection; the backend starts once the revocation list is reachable.",
  },
  PLUGIN_TAB_BLOCKED: {
    title: "it was blocked by Cadencr",
    restart: false,
    advice: "Remove it, or update it to a version that isn't blocked, from the Marketplace.",
  },
  PLUGIN_BACKEND_NOT_READY: { title: "its backend didn't get ready in time", restart: false },
  // These hold until the user allows a restart from the tab's Activity.
  PLUGIN_BACKEND_PROTOCOL_MISMATCH: { title: "its backend speaks another protocol", restart: true },
  PLUGIN_BACKEND_CRASHING: { title: "its backend keeps crashing", restart: true },
  // Ages out after a minute; a restart from the Activity clears it now. The
  // service's message stays short: the Activity says why it can't start.
  PLUGIN_BACKEND_START_FAILING: { title: "its backend keeps failing to start", restart: true },
};
const SURFACED: ReadonlyMap<string, SurfacedCopy> = new Map(Object.entries(SURFACED_COPY));

export interface BackendFailure {
  instanceId: string;
  /** `Ports: its backend is not code-signed`. */
  title: string;
  /** The service's explanation, as a sentence (an unsigned binary's names the `codesign` fix). */
  detail: string;
  /** Starts are blocked until a restart is allowed from the Activity dialog. */
  restart: boolean;
}

export interface BackendFailureDeps {
  report: (failure: BackendFailure) => void;
  /** The reported failure is over: the backend answered, or the tab closed. */
  clear: (instanceId: string) => void;
}

const toastId = (instanceId: string): string => `plugin-tab-backend:${instanceId}`;

const defaultDeps: BackendFailureDeps = {
  report: ({ instanceId, title, detail, restart }) =>
    toast.error(title, {
      id: toastId(instanceId),
      description: detail,
      duration: 20_000,
      action: {
        label: restart ? "Restart from Activity" : "View activity",
        onClick: () => setPluginTabActivityOpen(instanceId),
      },
    }),
  clear: (instanceId) => toast.dismiss(toastId(instanceId)),
};

function sentence(message: string): string {
  const clause = reasonClause(message);
  return clause === "" ? "Cadencr gave no detail." : `${capitalize(clause)}.`;
}

/**
 * Watches one tab instance's `backend.request` outcomes and reports a
 * blocking failure once per streak: again only when the failure changes, or
 * after the backend answered in between. The page still gets its rejection.
 */
export class BackendFailureWatch {
  private reported: string | null = null;

  constructor(
    private readonly instanceId: string,
    private readonly deps: BackendFailureDeps = defaultDeps,
  ) {}

  failed(pluginName: string, error: unknown): void {
    const { code, message } = toBrokerError(error);
    const copy = SURFACED.get(code);
    if (!copy || this.reported === code) return;
    this.reported = code;
    const explanation = copy.summary ?? sentence(message);
    this.deps.report({
      instanceId: this.instanceId,
      title: `${pluginName}: ${copy.title}`,
      detail: copy.advice ? `${explanation} ${copy.advice}` : explanation,
      restart: copy.restart,
    });
  }

  /** The backend answered (its own errors included): it runs again. */
  answered(): void {
    this.end();
  }

  dispose(): void {
    this.end();
  }

  private end(): void {
    if (this.reported === null) return;
    this.reported = null;
    this.deps.clear(this.instanceId);
  }
}
