import { MessageChannelMain, type MessagePortMain } from "electron";

import { PLUGIN_TAB_RENDERER_PORT_CHANNEL } from "../../../src/shared/plugin-tab-host";
import { GUEST_PORT_CHANNEL } from "./plugin-tab-ids";

interface PortTarget {
  isDestroyed: () => boolean;
  postMessage: (channel: string, message: unknown, transfer?: MessagePortMain[]) => void;
}

interface PortPair {
  port1: MessagePortMain;
  port2: MessagePortMain;
}

/**
 * Port bootstrap (docs/CUSTOM_TABS.md §5.3): on every guest load the main
 * process mints a fresh `MessageChannelMain`, sends one end to the guest and
 * the other to the main window. The main process never talks on the channel —
 * guest and broker speak directly. Ports are closed when superseded so a
 * reloaded guest never keeps a half-open pair alive.
 */
export class PluginTabPorts {
  private readonly pairs = new Map<string, PortPair>();

  constructor(private readonly createChannel: () => PortPair = () => new MessageChannelMain()) {}

  /** Sends nothing when either side is gone. */
  bootstrap(instanceId: string, guest: PortTarget, renderer: PortTarget | null): void {
    this.release(instanceId);
    if (!renderer || renderer.isDestroyed() || guest.isDestroyed()) return;
    const pair = this.createChannel();
    guest.postMessage(GUEST_PORT_CHANNEL, null, [pair.port1]);
    renderer.postMessage(PLUGIN_TAB_RENDERER_PORT_CHANNEL, { instanceId }, [pair.port2]);
    this.pairs.set(instanceId, pair);
  }

  release(instanceId: string): void {
    const pair = this.pairs.get(instanceId);
    if (!pair) return;
    this.pairs.delete(instanceId);
    // Both ends were transferred, so these are the main-side handles; closing
    // them is a safe no-op on Electron 42 and disentangles anything left.
    pair.port1.close();
    pair.port2.close();
  }

  releaseAll(): void {
    for (const instanceId of [...this.pairs.keys()]) this.release(instanceId);
  }
}
