/**
 * `@cadencr/tab-sdk/api` — the typed client of the plugin API surface.
 *
 * One function per route a custom tab may call (the service's policy table,
 * `docs/CUSTOM_TABS.md` §4.3), generated from `dump-openapi --plugin-surface`.
 * Each goes through `pluginFetch`: it needs a prior `connect()`, resolves the
 * parsed JSON body and throws `CadencrError` (`PLUGIN_SCOPE_DENIED`,
 * `PLUGIN_BINDING_DENIED`, …) on non-2xx. Routes outside the tab's consented
 * scopes are generated too and fail at call time; `client.api.request` stays
 * the untyped escape hatch.
 */
export * from "./generated/api.js";
