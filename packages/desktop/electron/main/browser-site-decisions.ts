import { browserPartitionForProfile, type BrowserProfile } from "./browser-profiles";
import { BrowserSitePermissionStore } from "./browser-site-permission-store";
import type { ManagedTab } from "./browser-tab-events";
import { decisionKey, errorMessage } from "./browser-site-permission-policy";
import {
  BROWSER_SITE_PERMISSIONS,
  type BrowserSitePermission,
  type BrowserSitePermissionDecision,
} from "./browser-types";

/** The tab asking: its profile picks the store, its identity owns any read error. */
type DecisionTab = Pick<ManagedTab, "profile" | "metadata">;

export class BrowserSiteDecisions {
  private readonly privateDecisions = new Map<string, BrowserSitePermissionDecision>();

  constructor(
    private readonly store: BrowserSitePermissionStore,
    private readonly reportError: (message: string, tab: DecisionTab) => void,
  ) {}

  forOrigin(
    tab: DecisionTab,
    origin: string | null,
  ): Record<BrowserSitePermission, BrowserSitePermissionDecision> {
    return Object.fromEntries(
      BROWSER_SITE_PERMISSIONS.map((permission) => [
        permission,
        origin ? this.safeGet(tab, origin, permission) : "ask",
      ]),
    ) as Record<BrowserSitePermission, BrowserSitePermissionDecision>;
  }

  safeGet(
    tab: DecisionTab,
    origin: string,
    permission: BrowserSitePermission,
  ): BrowserSitePermissionDecision {
    const { profile } = tab;
    try {
      const partition = browserPartitionForProfile(profile);
      if (profile.mode === "persistent") return this.store.get(partition, origin, permission);
      return this.privateDecisions.get(decisionKey(partition, origin, permission)) ?? "ask";
    } catch (error) {
      this.reportError(errorMessage(error), tab);
      return "deny";
    }
  }

  set(
    profile: BrowserProfile,
    origin: string,
    permission: BrowserSitePermission,
    decision: BrowserSitePermissionDecision,
  ): void {
    this.setMany(profile, origin, [[permission, decision]]);
  }

  setMany(
    profile: BrowserProfile,
    origin: string,
    updates: ReadonlyArray<readonly [BrowserSitePermission, BrowserSitePermissionDecision]>,
  ): void {
    const partition = browserPartitionForProfile(profile);
    if (profile.mode === "persistent") {
      this.store.setMany(partition, origin, updates);
      return;
    }
    for (const [permission, decision] of updates) {
      const key = decisionKey(partition, origin, permission);
      if (decision === "ask") this.privateDecisions.delete(key);
      else this.privateDecisions.set(key, decision);
    }
  }

  deleteOrigin(profile: BrowserProfile, origin: string): void {
    const partition = browserPartitionForProfile(profile);
    if (profile.mode === "persistent") {
      this.store.deleteOrigin(partition, origin);
      return;
    }
    for (const permission of BROWSER_SITE_PERMISSIONS) {
      this.privateDecisions.delete(decisionKey(partition, origin, permission));
    }
  }

  deletePrivatePartition(partition: string): void {
    for (const key of this.privateDecisions.keys()) {
      if (key.startsWith(`${partition}\n`)) this.privateDecisions.delete(key);
    }
  }
}
