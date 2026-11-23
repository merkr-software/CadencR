//! File watchers and process-lifetime background tasks, started once the
//! shared state exists and before the listener accepts clients.

use std::path::Path;

use tracing::info;

use crate::app_state::AppState;
use crate::{domain, shared};

pub(super) fn start_watchers(state: &AppState, settings_dir: &Path) {
    // Watch the settings dir so external edits to the JSON files push a
    // live refresh to connected clients.
    domain::settings_store::watcher::start(settings_dir, state.settings_events_tx.clone());

    // Same idea for user themes: editing `theme.json` in your own editor
    // re-injects the tokens live, with no reload.
    domain::themes::watcher::start(
        &domain::themes::paths::themes_dir(),
        state.theme_events_tx.clone(),
    );

    domain::plugin_tabs::watcher::start(
        &domain::plugin_tabs::paths::tabs_dir(),
        state.plugin_tab_events_tx.clone(),
    );
    // Permission changes and revocations revoke live grants (blocked: backends stop first).
    tokio::spawn(domain::plugin_tabs::grants::revoke_on_manifest_change(
        state.plugin_tab_grants.clone(),
        state.plugin_tab_backends.clone(),
        state.plugin_tab_events_tx.subscribe(),
    ));
    state
        .plugin_tab_backends
        .spawn_reaper(&state.plugin_tab_presence);

    // A theme is built in a project named after it, and renaming a theme
    // is editing its file — so the same event that reloads the theme
    // renames the project in the sidebar.
    tokio::spawn(domain::themes::workspace::watch_renames(
        state.write_pool.clone(),
        state.theme_events_tx.subscribe(),
        state.theme_events_tx.clone(),
    ));

    // Watch alacritty.toml so external edits push a live refresh to
    // connected clients, the same way the settings watcher above does
    // for the settings directory.
    domain::terminal::alacritty_config::start_watcher(state.alacritty_config_events_tx.clone());
}

pub(super) async fn spawn_background_work(state: &AppState) -> anyhow::Result<()> {
    // Background Web Push dispatcher: turns agent finished / needs-input
    // transitions into native push for backgrounded remote PWAs. Cheap
    // when no subscriptions exist; runs for the process lifetime.
    tokio::spawn(domain::push::dispatcher::run(state.clone()));
    // Push user-selected CLI binary paths into the SDK overrides
    // BEFORE the warmup runs — the opencode warmup spawns the server
    // process, which needs to honor the override on first launch.
    domain::agents::apply_binary_overrides_from_settings(&state.read_pool).await;
    domain::agents::spawn_runtime_startup_warmups();
    state.provider_updates.spawn_periodic_checks();
    domain::agents::providers::installed::managed::service::spawn_startup_blocklist_refresh();

    reconcile_orphaned_runs(state).await;

    // Background dispatcher for user schedules (one poll loop for the
    // process lifetime; survives client disconnects).
    domain::schedules::scheduler::spawn(state.clone());
    domain::restart_continuations::spawn_startup_pass(state.clone());
    domain::features::archive_cleanup::runner::recover_at_startup(state).await?;
    domain::prompt_queue::sweep::spawn(state.clone());
    // Detect Git once, off the runtime: version-gated Git flows read
    // the cached result, and an old Git is logged here once.
    tokio::task::spawn_blocking(shared::git_cli::version::detect);
    domain::git::forge::spawn(state.clone());
    domain::git::linked_branches::spawn(state.clone());
    Ok(())
}

async fn reconcile_orphaned_runs(state: &AppState) {
    // Reconcile custom-action runs orphaned by the previous exit: their
    // processes died with the old service instance, so finalize them
    // instead of leaving the UI stuck "running" and unable to re-run.
    match domain::custom_actions::repository::fail_orphaned_runs(&state.write_pool).await {
        Ok(n) if n > 0 => info!(count = n, "reconciled orphaned custom action runs"),
        Ok(_) => {}
        Err(e) => tracing::warn!("failed to reconcile orphaned custom action runs: {e}"),
    }
    // Same for sub-agents: none outlives the service that ran it.
    domain::subagents::stop_runs_orphaned_by_restart(&state.write_pool).await;
}
