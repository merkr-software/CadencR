//! Background task that turns session-status transitions into Web Push.
//!
//! It subscribes to the same broadcast the WebSocket consumes and fires a push
//! on the two transitions the frontend already notifies on — agent finished
//! (`Agent → Idle`) and agent needs input (`→ Question`) — but ONLY to remote
//! devices that don't currently hold a live socket. A foregrounded tab keeps its
//! WebSocket, so it gets the live/in-app path and is skipped here; a
//! backgrounded, locked, or closed PWA has dropped its socket and gets the push.

use std::collections::HashMap;

use tokio::sync::broadcast::error::RecvError;

use super::{is_gone, repo};
use crate::app_state::AppState;
use crate::domain::session_status::{AgentStatus, SessionStatusEvent};
use crate::error::AppError;

#[derive(Clone, Copy)]
enum PushKind {
    Completed,
    NeedsInput,
}

impl PushKind {
    /// Status emoji prefixed to the notification title (`<emoji> | <feature>`).
    fn emoji(self) -> &'static str {
        match self {
            PushKind::Completed => "🟢",
            PushKind::NeedsInput => "🟠",
        }
    }
}

/// Run until the broadcast channel closes (process shutdown). Spawned once at
/// startup; cheap when no push subscriptions exist (one DB read per relevant
/// transition, which only fire at turn end / question — never mid-stream).
pub async fn run(state: AppState) {
    let mut rx = state.session_status_tx.subscribe();
    // Last status seen per session, so we can detect the prev→next transition
    // (the broadcast carries only the new status). Mirrors the frontend's
    // `notifyTransition` rule.
    let mut prev: HashMap<i64, AgentStatus> = HashMap::new();

    loop {
        let event = match rx.recv().await {
            Ok(event) => event,
            // Lagged: we dropped some events under load. Status is self-healing
            // (the next transition re-establishes prev), so just keep going.
            Err(RecvError::Lagged(n)) => {
                tracing::warn!(
                    skipped = n,
                    "push dispatcher lagged behind status broadcast"
                );
                continue;
            }
            Err(RecvError::Closed) => break,
        };

        let previous = prev.insert(event.session_id, event.status);
        let Some(kind) = classify(previous, event.status) else {
            continue;
        };
        if let Err(err) = dispatch(&state, &event, kind).await {
            tracing::warn!(%err, feature_id = event.feature_id, "failed to dispatch push");
        }
    }
}

/// Map a prev→next status pair to a push, matching the frontend exactly:
/// needs-input on entering Question (from anything but Question), completed on
/// Agent→Idle.
fn classify(prev: Option<AgentStatus>, next: AgentStatus) -> Option<PushKind> {
    match next {
        AgentStatus::Question if prev != Some(AgentStatus::Question) => Some(PushKind::NeedsInput),
        AgentStatus::Idle if prev == Some(AgentStatus::Agent) => Some(PushKind::Completed),
        _ => None,
    }
}

async fn dispatch(
    state: &AppState,
    event: &SessionStatusEvent,
    kind: PushKind,
) -> Result<(), AppError> {
    let subs = repo::list_active_subscriptions(&state.read_pool).await?;
    if subs.is_empty() {
        return Ok(());
    }
    let connected = state.remote.live().connected_device_ids();
    let targets: Vec<_> = subs
        .into_iter()
        .filter(|sub| !connected.contains(&sub.device_id))
        .collect();
    if targets.is_empty() {
        return Ok(());
    }

    let Some(feature) =
        crate::domain::features::repository::get_by_id(&state.read_pool, event.feature_id).await?
    else {
        return Ok(());
    };
    // Body is the start of the agent's latest reply; fall back to the feature
    // title when there's no reply text yet (shared with the desktop path).
    let preview = crate::domain::sessions::repository::latest_assistant_preview(
        &state.read_pool,
        event.feature_id,
    )
    .await?;
    // Title format `<emoji> | <feature title>` is mirrored on the desktop
    // (Electron-native) path in `notify-agent-done.ts` (`statusEmoji`); keep
    // the two in sync.
    let payload = serde_json::json!({
        "title": format!("{} | {}", kind.emoji(), feature.title),
        "body": preview.unwrap_or(feature.title),
        "feature_id": event.feature_id,
        "project_id": feature.project_id,
    });
    let bytes = serde_json::to_vec(&payload)
        .map_err(|e| AppError::Internal(format!("serialize push payload: {e}")))?;

    for sub in targets {
        if let Err(err) = state.push.send(&sub, &bytes).await {
            if is_gone(&err) {
                // The browser dropped this subscription — prune it so we stop
                // retrying a dead endpoint.
                if let Err(del) =
                    repo::delete_subscription_by_endpoint(&state.write_pool, &sub.endpoint).await
                {
                    tracing::warn!(%del, "failed to prune gone push subscription");
                }
            } else {
                tracing::warn!(%err, device_id = sub.device_id, "web push send failed");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_matches_frontend_rules() {
        // Needs-input: entering Question from idle/agent/none.
        assert!(matches!(
            classify(Some(AgentStatus::Agent), AgentStatus::Question),
            Some(PushKind::NeedsInput)
        ));
        assert!(matches!(
            classify(None, AgentStatus::Question),
            Some(PushKind::NeedsInput)
        ));
        // Already in Question (e.g. permission → question kind change) — no repeat.
        assert!(classify(Some(AgentStatus::Question), AgentStatus::Question).is_none());

        // Completed only on Agent → Idle.
        assert!(matches!(
            classify(Some(AgentStatus::Agent), AgentStatus::Idle),
            Some(PushKind::Completed)
        ));
        // Idle from question (gate answered, not a completion) — no push.
        assert!(classify(Some(AgentStatus::Question), AgentStatus::Idle).is_none());
        // Idle from nothing (snapshot hydrate) — no push.
        assert!(classify(None, AgentStatus::Idle).is_none());

        // Turn start is never a push.
        assert!(classify(Some(AgentStatus::Idle), AgentStatus::Agent).is_none());
    }
}
