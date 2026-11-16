/**
 * The instance id of a custom tab placed in a feature page — one guest per
 * (feature, plugin). Matches `PLUGIN_TAB_INSTANCE_ID_PATTERN`.
 */
export function pluginTabInstanceId(featureId: number, pluginId: string): string {
  return `${featureId}:plugin:${pluginId}`;
}
