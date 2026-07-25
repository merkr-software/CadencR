/**
 * Spec-level operationId rewriter.
 *
 * The Rust handlers are named `*_handler`, which orval would otherwise turn
 * into `useFooHandler`. We strip the suffix so the generated hook is `useFoo`.
 *
 * A handful of operationIds also get explicit aliases so the generated names
 * match the domain prefixes used across the frontend (e.g. `useGetSetting`
 * from the workspace router becomes `useGetWorkspaceSetting` because feature
 * and project routers also expose a `useGetSetting`-style hook). The Rust
 * function name is intentionally short — the orval prefix carries the domain.
 */
const RENAMES = {
  // Workspace settings
  list_settings: "list_workspace_settings",
  get_setting: "get_workspace_setting",
  set_setting: "set_workspace_setting",
  get_model_settings: "get_workspace_model_settings",
  set_model_setting: "set_workspace_model_setting",
  get_provider_settings: "get_workspace_provider_settings",
  set_provider_setting: "set_workspace_provider_setting",
  // Sessions: drafts are session-scoped on the wire.
  get_draft: "get_session_draft",
  save_draft: "save_session_draft",
  // Editor: the routes file uses bare names; consumers expect domain prefix.
  tree: "file_tree",
  search: "file_search",
  // Features: drop the "is_empty" / "get_prd" / "get_plan_with_phases" minimalism.
  is_empty: "is_feature_empty",
  get_prd: "get_feature_prd",
  get_plan_with_phases: "get_feature_plan",
  get_plan_progress: "get_feature_plan_progress",
  get_working_dir: "get_feature_working_dir",
  // Custom actions: preserve the domain-specific hook names used by the UI.
  list_actions: "list_custom_actions",
  create_action: "create_custom_action",
  update_action: "update_custom_action",
  delete_action: "delete_custom_action",
  list_variables: "get_custom_action_variables",
  set_variable: "set_custom_action_variable",
  run_action: "run_custom_action",
  list_runs: "get_custom_action_runs",
  cancel_run: "cancel_custom_action_run",
  get_schedule: "get_custom_action_schedule",
  set_schedule: "set_custom_action_schedule",
  // Schedules: the Rust name is disambiguated from the custom-action one above,
  // but the hook should still read as the plain `useGetSchedule`.
  get_schedule_by_id: "get_schedule",
  // LSP: disambiguate the catalog probe from the generic "list servers" name.
  list_servers: "list_lsp_servers",
  // Remote access: the handlers use bare verbs (status/enable/pair/…); prefix
  // them so the generated hooks/functions don't collide and read as a group.
  status: "remote_status",
  enable: "remote_enable",
  disable: "remote_disable",
  pairing_code: "remote_pairing_code",
  pair: "remote_pair",
  revoke: "remote_revoke_device",
  set_tunnel_host: "remote_set_tunnel_host",
};

module.exports = (spec) => {
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(pathItem)) {
      if (!op || typeof op !== "object" || typeof op.operationId !== "string") {
        continue;
      }
      const stripped = op.operationId.replace(/_handler$/, "");
      op.operationId = RENAMES[stripped] ?? stripped;
    }
  }
  return spec;
};
