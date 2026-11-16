import {
  PLUGIN_TAB_ID_PATTERN,
  PLUGIN_TAB_INSTANCE_ID_PATTERN,
} from "../../../src/shared/plugin-tab-host";

/*
 * Guest-only channels. The sandboxed guest preload (`preload/plugin-tab.ts`)
 * cannot import a shared chunk, so it repeats these three as literals.
 */
/** Guest preload → main, synchronous: theme CSS to inject before first paint. */
export const GUEST_THEME_CSS_CHANNEL = "cadencr-tab:theme-css";
/** Main → guest preload: replacement theme CSS. */
export const GUEST_THEME_CHANNEL = "cadencr-tab:theme";
/** Main → guest preload: the guest's end of the broker port. */
export const GUEST_PORT_CHANNEL = "cadencr-tab:port";

/** Custom scheme every guest is served from: `cadencr-tab://<plugin id>/…`. */
export const PLUGIN_TAB_SCHEME = "cadencr-tab";

/**
 * Registration for `protocol.registerSchemesAsPrivileged`, which Electron allows
 * exactly once, before `app.ready` — any other privileged scheme must join the
 * same call in `index.ts`. `standard` gives each plugin its own origin (the id
 * is the host), `secure` makes it a secure context, `supportFetchAPI` + `stream`
 * let the relayed asset bodies stream through.
 */
export const PLUGIN_TAB_PRIVILEGED_SCHEME: Electron.CustomScheme = {
  scheme: PLUGIN_TAB_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
};

export function parsePluginId(value: unknown): string {
  if (typeof value !== "string" || !PLUGIN_TAB_ID_PATTERN.test(value)) {
    throw new Error("Expected a custom tab id.");
  }
  return value;
}

export function parseInstanceId(value: unknown): string {
  if (typeof value !== "string" || !PLUGIN_TAB_INSTANCE_ID_PATTERN.test(value)) {
    throw new Error("Expected a custom tab instance id.");
  }
  return value;
}

/** One persistent partition per plugin, so plugins never share storage. */
export function pluginTabPartition(pluginId: string): string {
  return `persist:${PLUGIN_TAB_SCHEME}:${pluginId}`;
}

export function pluginTabEntryUrl(pluginId: string): string {
  return `${PLUGIN_TAB_SCHEME}://${pluginId}/`;
}

/** True only for `cadencr-tab://<pluginId>/…` (Chromium lowercases hosts; we compare exactly). */
export function isOwnPluginTabUrl(rawUrl: string, pluginId: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === `${PLUGIN_TAB_SCHEME}:` && url.host === pluginId;
}
