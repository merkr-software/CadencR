import type { PluginTabSummary } from "@/api/generated";
import type { WantedLease } from "@/lib/plugin-tabs/broker-presence";
import { pluginEditorInstanceId } from "@/lib/plugin-tabs/instance-id";
import { acquirePluginSurfacePresence } from "@/lib/plugin-tabs/surface-presence";
import { pluginEditorUnavailable } from "./editor-registry";

export function wantedEditorLeases(
  selected: string,
  engaged: Readonly<Record<number, string>>,
  projects: Readonly<Record<number, number>>,
  listOf: (projectId: number) => PluginTabSummary[] | undefined,
): WantedLease[] {
  if (!selected.startsWith("plugin:")) return [];
  const pluginId = selected.slice("plugin:".length);
  return Object.entries(engaged).flatMap(([id, backendId]) => {
    const featureId = Number(id);
    const projectId = projects[featureId];
    if (backendId !== selected || projectId === undefined) return [];
    const plugin = listOf(projectId)?.find((candidate) => candidate.id === pluginId);
    if (!plugin || pluginEditorUnavailable(plugin)) return [];
    return [
      {
        instanceId: pluginEditorInstanceId(featureId, pluginId),
        featureId,
        pluginId,
        name: plugin.name,
      },
    ];
  });
}

/** Shares the mounted guest's lease, so leaving its page does not stop the process. */
export class EditorPresenceRegistry {
  private readonly owned = new Map<string, () => void>();
  constructor(private readonly acquire = acquirePluginSurfacePresence) {}

  sync(wanted: readonly WantedLease[]): void {
    const keep = new Set(wanted.map((lease) => lease.instanceId));
    for (const [id, release] of this.owned) {
      if (keep.has(id)) continue;
      release();
      this.owned.delete(id);
    }
    for (const lease of wanted) {
      if (!this.owned.has(lease.instanceId)) this.owned.set(lease.instanceId, this.acquire(lease));
    }
  }

  dispose(): void {
    this.sync([]);
  }
}
