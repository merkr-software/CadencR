import type { Session } from "electron";

import type { PluginTabAssetHandler } from "./plugin-tab-asset-handler";
import { isOwnPluginTabUrl, PLUGIN_TAB_SCHEME, pluginTabPartition } from "./plugin-tab-ids";

/**
 * Whether a request from a plugin's partition may proceed. The guest itself
 * only ever needs its own `cadencr-tab://<id>/` assets (plus in-process
 * `data:` / `blob:` URLs its CSP allows for images and fonts). `devtools:` is
 * required because a detached DevTools front-end shares the inspected page's
 * session and loads its bundle from `devtools://devtools/bundled/…` (verified
 * on Electron 42). Everything else — http(s), ws(s), file, other plugins'
 * hosts, extensions — is cancelled.
 */
export function isAllowedPluginTabRequest(rawUrl: string, pluginId: string): boolean {
  if (rawUrl.startsWith(`${PLUGIN_TAB_SCHEME}:`)) return isOwnPluginTabUrl(rawUrl, pluginId);
  return rawUrl.startsWith("devtools:") || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:");
}

/** Deny-by-default session policy for one plugin partition (docs/CUSTOM_TABS.md §5.1). */
export function hardenPluginTabSession(ses: Session, pluginId: string): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedPluginTabRequest(details.url, pluginId) });
  });
  ses.on("will-download", (event) => event.preventDefault());
  ses.setSpellCheckerEnabled(false);
}

export interface PluginTabSessionDeps {
  fromPartition: (partition: string) => Session;
  createAssetHandler: (pluginId: string) => PluginTabAssetHandler;
}

/**
 * Prepares each plugin partition exactly once per process: hardening plus the
 * partition-scoped `cadencr-tab` protocol handler. Electron throws on a second
 * `protocol.handle` for the same scheme, and partitions outlive every view
 * (and every main window), so the record lives as long as the manager.
 */
export class PluginTabSessions {
  private readonly prepared = new Map<string, Session>();

  constructor(private readonly deps: PluginTabSessionDeps) {}

  prepare(pluginId: string): Session {
    const partition = pluginTabPartition(pluginId);
    const existing = this.prepared.get(partition);
    if (existing) return existing;
    const ses = this.deps.fromPartition(partition);
    hardenPluginTabSession(ses, pluginId);
    ses.protocol.handle(PLUGIN_TAB_SCHEME, this.deps.createAssetHandler(pluginId));
    this.prepared.set(partition, ses);
    return ses;
  }
}
