/** Compatibility exports: custom tabs use the shared editor/tab surface host. */
export {
  usePluginSurface as usePluginTabGuest,
  type GuestPhase,
  type PluginSurfaceOptions as PluginTabGuestOptions,
  type PluginSurface as PluginTabGuest,
} from "../plugin-surfaces/usePluginSurface";
