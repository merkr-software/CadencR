#[async_trait]
impl AgentRuntimeAdapter for CodexAdapter {
    async fn resolve_profile_for_selection(
        &self,
        selection: Option<&str>,
        _cwd: &std::path::Path,
    ) -> Result<Option<ResolvedRuntimeProfile>, RuntimeError> {
        profile_runtime::resolve_profile_for_selection(selection).map(Some)
    }
    fn supports_profile_config_inheritance(&self) -> bool {
        true
    }
    async fn resolve_profile_effective_config(
        &self,
        selection: Option<&str>,
        cwd: &std::path::Path,
        overrides: &RuntimeConfigOverrides,
    ) -> Result<RuntimeEffectiveConfig, RuntimeError> {
        profile_runtime::resolved_effective_config(selection, cwd, overrides).await
    }
    async fn profile_catalog(
        &self,
        _cwd: Option<&std::path::Path>,
    ) -> Result<Option<super::runtime::ProviderProfilesResponse>, RuntimeError> {
        Ok(Some(profile_runtime::profile_catalog()))
    }

    async fn resolve_profile(
        &self,
        selection: Option<&str>,
        cwd: &std::path::Path,
    ) -> Result<Option<ResolvedRuntimeProfile>, RuntimeError> {
        profile_runtime::resolve_profile(selection, cwd)
            .await
            .map(Some)
    }

    async fn catalog_entry_live_for_settings(
        &self,
        _read_pool: &sqlx::SqlitePool,
        cwd: Option<&std::path::Path>,
        profile: Option<&str>,
    ) -> ProviderCatalogEntry {
        profile_runtime::catalog_for_profile(
            profile,
            cwd.unwrap_or_else(|| std::path::Path::new(".")),
        )
        .await
    }

    fn user_shell_strategy(&self) -> RuntimeUserShellStrategy {
        RuntimeUserShellStrategy::ProviderNative
    }

    fn prompt_command_policy(&self) -> RuntimePromptCommandPolicy {
        RuntimePromptCommandPolicy {
            slash_command_placement: RuntimePromptCommandPlacement::PromptStart,
            skill_reference_trigger: RuntimeSkillReferenceTrigger::Dollar,
            user_shell: true,
        }
    }

    fn session_branching(&self) -> Option<&dyn super::adapter::SessionBranching> {
        Some(&branching::CODEX_SESSION_BRANCHING)
    }

    fn parse_permission_request(&self, raw: &Value) -> Option<RuntimePermissionRequest> {
        permissions::parse_permission_request(raw)
    }

    fn catalog_entry(&self) -> ProviderCatalogEntry {
        unavailable_catalog("Codex availability has not been checked yet")
    }

    async fn catalog_entry_live(&self) -> ProviderCatalogEntry {
        live_catalog().await
    }

    async fn default_model_id(&self) -> Option<String> {
        live_catalog().await.default_model
    }

    fn spawn_startup_warmup(&self) {
        tokio::spawn(async {
            let _ = live_catalog().await;
        });
    }

    fn supports_prompt_receipts(&self) -> bool {
        true
    }

    fn worktree_config_paths(&self) -> Vec<Cow<'static, str>> {
        static_config_paths(worktree_config::CONFIG_PATHS)
    }

    async fn runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        commands::runtime_slash_commands(cwd, None).await
    }

    async fn runtime_slash_commands_for_profile(
        &self,
        cwd: &str,
        profile: Option<&str>,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        commands::runtime_slash_commands(cwd, profile).await
    }

    fn compaction_strategy(&self) -> Option<RuntimeCompactionStrategy> {
        Some(RuntimeCompactionStrategy::LiveRuntime)
    }

    fn supports_permission_mode(
        &self,
        mode: &crate::domain::agents::adapter::RuntimePermissionMode,
    ) -> bool {
        use crate::domain::agents::adapter::RuntimePermissionMode;
        matches!(
            mode,
            RuntimePermissionMode::Default
                | RuntimePermissionMode::AcceptEdits
                | RuntimePermissionMode::Plan
                | RuntimePermissionMode::BypassPermissions
        )
    }

    fn supports_access_mode(&self, _mode: &RuntimeAccessMode) -> bool {
        true
    }

    fn access_mode_setting_key(&self) -> Option<Cow<'static, str>> {
        Some(Cow::Borrowed(self::model::ACCESS_MODE_SETTING_KEY))
    }

    fn applies_access_mode_in_place(&self) -> bool {
        true
    }

    fn default_permission_mode_wire(&self) -> Cow<'static, str> {
        Cow::Borrowed("default")
    }

    async fn spawn(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        let client =
            CodexAppServerClient::spawn_with_options(profile_runtime::app_server_spawn_options(
                config.env.clone(),
                config.env_unset.clone(),
                Some(config.cwd.clone()),
            ))
            .await?;
        client.initialize().await?;
        let mut effective_config = client
            .config_read(&config.cwd)
            .await
            .map_err(|_| RuntimeError::new("Codex rejected the effective configuration"))?;
        let models = client.model_list().await?;
        profile_runtime::enrich_resume_config(
            &mut effective_config,
            &models,
            config.overrides.model.as_deref(),
        );
        let native_effective = profile_runtime::native_effective_config(&effective_config);
        let effective_model = config.overrides.model.clone().or(native_effective.model);
        let effective_effort = config
            .overrides
            .thinking_effort
            .clone()
            .or(native_effective.thinking_effort);
        let event_rx = client.subscribe_reliable();
        let mut mcp_status_rx = client.subscribe();
        let mcp_config = launch::effective_thread_config(&config, &effective_config);
        let mcp_server_names = mcp_server_names(&mcp_config);
        let thread_id = launch::start_or_resume_thread(&client, &config, &mcp_config).await?;
        let session = CodexSession::new(
            client.clone(),
            thread_id,
            event_rx,
            session::CodexSessionOptions {
                model: config.overrides.model,
                effort: config.overrides.thinking_effort,
                effective_model,
                effective_effort,
                fast_mode: config.overrides.fast_mode,
                permission_mode: config.permission_mode,
                access_mode: config.access_mode,
                cwd: config.cwd,
                context_window: None,
            },
        );
        // Start the turn before reading MCP statuses: `mcpServerStatus/list`
        // blocks until every MCP server has started (seconds for npx-launched
        // ones), and Codex already holds the turn's first model request on that
        // same startup. Awaiting the list first stacked the two waits. Turn
        // events queue until the stream is taken, and `take_message_rx` puts
        // the queued init event ahead of them.
        if !content.is_null() {
            session.start_initial_turn(content).await?;
        }
        let mcp_servers = mcp_server_statuses(&client, &mut mcp_status_rx, &mcp_server_names).await;
        session.set_mcp_servers(mcp_servers).await;
        session.send_init_event().await;
        Ok(Box::new(session))
    }
}
