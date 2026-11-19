import { PresenceLease, type PresenceDeps, type WantedLease } from "./broker-presence";

interface OwnedLease {
  wanted: WantedLease;
  lease: PresenceLease;
  references: number;
}

/** Logical surface presence survives native guest recycling and hiding. */
export class SurfacePresenceLeases {
  private readonly leases = new Map<string, OwnedLease>();

  constructor(private readonly deps?: PresenceDeps) {}

  acquire(wanted: WantedLease): () => void {
    let owned = this.leases.get(wanted.instanceId);
    if (
      owned &&
      (owned.wanted.pluginId !== wanted.pluginId || owned.wanted.featureId !== wanted.featureId)
    ) {
      throw new Error("A plugin surface lease cannot change identity");
    }
    if (!owned) {
      owned = {
        wanted,
        lease: new PresenceLease(wanted.pluginId, wanted.featureId, wanted.name, this.deps),
        references: 0,
      };
      this.leases.set(wanted.instanceId, owned);
    }
    owned.references += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      owned.references -= 1;
      if (owned.references > 0) return;
      this.leases.delete(wanted.instanceId);
      owned.lease.dispose();
    };
  }
}

const surfaces = new SurfacePresenceLeases();

export function acquirePluginSurfacePresence(wanted: WantedLease): () => void {
  return surfaces.acquire(wanted);
}
