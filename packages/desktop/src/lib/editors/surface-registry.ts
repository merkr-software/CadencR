import type { BackendRequestResult, EditorOpenFileParams } from "@cadencr/tab-sdk/protocol";

export interface PluginSurfaceControls {
  requestBackend: (method: string, params: EditorOpenFileParams) => Promise<BackendRequestResult>;
  focus: () => void | Promise<void>;
}

/** Only connected surfaces can accept navigation; waiting never starts a backend. */
export class PluginSurfaceRegistry {
  private readonly surfaces = new Map<string, PluginSurfaceControls>();
  private readonly waiting = new Map<string, Set<(controls: PluginSurfaceControls) => void>>();

  register(instanceId: string, controls: PluginSurfaceControls): () => void {
    this.surfaces.set(instanceId, controls);
    for (const ready of this.waiting.get(instanceId) ?? []) ready(controls);
    return () => {
      if (this.isCurrent(instanceId, controls)) this.surfaces.delete(instanceId);
    };
  }

  isCurrent(instanceId: string, controls: PluginSurfaceControls): boolean {
    return this.surfaces.get(instanceId) === controls;
  }

  async focus(instanceId: string): Promise<boolean> {
    const controls = this.surfaces.get(instanceId);
    if (!controls) return false;
    await controls.focus();
    return true;
  }

  wait(instanceId: string, timeoutMs = 15_000): Promise<PluginSurfaceControls> {
    const available = this.surfaces.get(instanceId);
    if (available) return Promise.resolve(available);
    return new Promise((resolve, reject) => {
      const waiting = this.waiting.get(instanceId) ?? new Set();
      this.waiting.set(instanceId, waiting);
      const cleanup = (): void => {
        waiting.delete(ready);
        if (waiting.size === 0) this.waiting.delete(instanceId);
        clearTimeout(timer);
      };
      const ready = (controls: PluginSurfaceControls): void => {
        cleanup();
        resolve(controls);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The plugin editor surface did not become available."));
      }, timeoutMs);
      waiting.add(ready);
    });
  }
}
