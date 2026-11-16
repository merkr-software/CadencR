import { toast } from "sonner";

import { pluginTabReleasePresence, pluginTabRenewPresence } from "@/api/generated";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";

import { PLUGIN_TAB_ERROR } from "./error-codes";

/** How often the lease is renewed; the service lets it lapse after 3 minutes. */
export const PRESENCE_RENEW_MS = 60_000;
/**
 * A renewal aborted at close may still reach the service after the release
 * and take the lease again: it is released once more this long after.
 */
export const PRESENCE_RERELEASE_MS = 10_000;

export interface PresenceDeps {
  renew: (
    pluginId: string,
    leaseId: string,
    featureId: number,
    signal: AbortSignal,
  ) => Promise<unknown>;
  release: (pluginId: string, leaseId: string) => Promise<unknown>;
  /** A renewal failed (once per failure streak), or the release did. */
  report: (message: string, error: unknown) => void;
  newLeaseId: () => string;
}

const defaultPresenceDeps: PresenceDeps = {
  renew: (pluginId, leaseId, featureId, signal) =>
    pluginTabRenewPresence(pluginId, leaseId, { feature_id: featureId }, signal),
  release: (pluginId, leaseId) => pluginTabReleasePresence(pluginId, leaseId),
  report: (message, error) =>
    toast.error(message, {
      id: "plugin-tab-presence",
      description: apiErrorMessage(error, "unknown error"),
    }),
  newLeaseId: () => crypto.randomUUID(),
};

/** A renewal that did not finish before the next one was due. */
class RenewalStalled extends Error {
  constructor() {
    super("The previous renewal did not finish within a minute");
  }
}

/**
 * The presence lease of one open tab instance with a native backend
 * (docs/CUSTOM_TABS.md §4.7): taken when the tab opens, renewed every minute
 * while it stays in its conversation's tab strip — shown or hidden, its
 * conversation on screen or not, idle or not — and released when it closes.
 * The backend runs as long as some instance of its tab holds one; the
 * instance's grant, minted only on use, says nothing about whether it is open.
 * `PresenceRegistry` owns them, not the tab's view.
 *
 * The lease is taken on the next task, not in the constructor: an instance
 * torn down in the same task — React StrictMode's mount, unmount, mount in
 * development — never takes one, so one open tab holds one lease.
 *
 * Closing never waits on a renewal: one still in flight is aborted and the
 * lease released at once. Should that renewal still land after the release
 * (it succeeds anyway, or the service got it first), the lease is released
 * again — right then, and once more after `PRESENCE_RERELEASE_MS`. Those
 * repeats name the same lease, and releasing a released lease is a no-op.
 *
 * A conversation deleted elsewhere ends the lease for good: renewals stop,
 * silently — the tab is gone, not failing. An archived one refuses them, as
 * silently, and its backend stops; renewals go on, so unarchiving it takes
 * the lease again within a minute.
 */
export class PresenceLease {
  private readonly leaseId: string;
  private readonly start: ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The renewal in flight, if any. */
  private pending: AbortController | null = null;
  private failing = false;
  /** Closed by its owner. */
  private disposed = false;
  /** Taken back by the service (its conversation was deleted): nothing to release. */
  private ended = false;

  constructor(
    private readonly pluginId: string,
    private readonly featureId: number,
    private readonly label: string,
    private readonly deps: PresenceDeps = defaultPresenceDeps,
  ) {
    this.leaseId = deps.newLeaseId();
    this.start = setTimeout(() => {
      this.renew();
      this.timer = setInterval(() => this.renew(), PRESENCE_RENEW_MS);
    }, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.start);
    // Never taken, or already taken back: nothing to release.
    if (this.timer === null || this.ended) return;
    clearInterval(this.timer);
    const inflight = this.pending;
    this.pending = null;
    inflight?.abort();
    this.release();
    if (inflight) setTimeout(() => this.release(), PRESENCE_RERELEASE_MS);
  }

  /**
   * Renew no more. The registry keeps the ended lease while the stale layout
   * still places the tab, so it is not taken again.
   */
  private end(): void {
    this.ended = true;
    if (this.timer !== null) clearInterval(this.timer);
  }

  private release(): void {
    this.deps
      .release(this.pluginId, this.leaseId)
      .catch((error: unknown) =>
        this.deps.report(
          `${this.label} was closed but its backend could not be stopped right away (it stops within 3 minutes)`,
          error,
        ),
      );
  }

  private renew(): void {
    // A renewal still running a minute later is stuck: it gives way, as a failure.
    this.pending?.abort(new RenewalStalled());
    const controller = new AbortController();
    this.pending = controller;
    this.deps.renew(this.pluginId, this.leaseId, this.featureId, controller.signal).then(
      () => {
        if (this.pending === controller) this.pending = null;
        // It landed after the close: the lease it took again must go too.
        if (this.disposed) this.release();
        else this.failing = false;
      },
      (error: unknown) => {
        if (this.pending === controller) this.pending = null;
        if (this.disposed || this.ended) return;
        const code = apiErrorCode(error);
        if (code === PLUGIN_TAB_ERROR.conversationNotFound) {
          this.end();
          return;
        }
        if (code === PLUGIN_TAB_ERROR.conversationArchived) return;
        if (this.failing) return;
        this.failing = true;
        const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
        this.deps.report(
          `${this.label}: Cadencr could not be told the tab is open, so its backend may stop`,
          reason,
        );
      },
    );
  }
}

/** One open tab instance that should hold a lease. */
export interface WantedLease {
  /** `pluginTabInstanceId(featureId, pluginId)`: one lease per instance. */
  instanceId: string;
  pluginId: string;
  featureId: number;
  /** For its failure toasts. */
  name: string;
}

/**
 * Every presence lease of this window, one per open tab instance: `sync` takes
 * the wanted set (the tabs placed in any conversation's tab strip whose
 * backend can run) and takes or releases leases to match.
 */
export class PresenceRegistry {
  private readonly leases = new Map<string, PresenceLease>();

  constructor(private readonly deps: PresenceDeps = defaultPresenceDeps) {}

  sync(wanted: readonly WantedLease[]): void {
    const keep = new Set(wanted.map((lease) => lease.instanceId));
    for (const [instanceId, lease] of this.leases) {
      if (keep.has(instanceId)) continue;
      lease.dispose();
      this.leases.delete(instanceId);
    }
    for (const { instanceId, pluginId, featureId, name } of wanted) {
      if (this.leases.has(instanceId)) continue;
      this.leases.set(instanceId, new PresenceLease(pluginId, featureId, name, this.deps));
    }
  }

  dispose(): void {
    this.sync([]);
  }
}
