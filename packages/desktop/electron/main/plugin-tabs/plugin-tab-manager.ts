/** Compatibility exports: tabs and editors share one native surface host. */
export {
  PluginSurfaceManager as PluginTabManager,
  MAX_LIVE_PLUGIN_TAB_GUESTS,
  type PluginSurfaceManagerDeps as PluginTabManagerDeps,
} from "./plugin-surface-manager";
