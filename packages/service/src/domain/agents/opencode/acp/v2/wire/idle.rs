//! Ends the replies OpenCode 2.x streams outside a prompt.
//!
//! A finished sub-agent wakes its parent, which answers outside any
//! `session/prompt`, and OpenCode's ACP sends nothing when that turn ends. Its
//! database records the end (`session_v2.time_idle` catching up with
//! `time_busy`), so while such a reply streams, or while the host holds the
//! conversation for sub-agents that already finished, the watcher reads that
//! row (read-only, every [`POLL_INTERVAL`]) and sends the host the boundary it
//! expects: `usage_update` with `_meta.cadencr.detachedReplyEnded`, or a
//! `session_info_update` releasing `backgroundWorkPending`.

use std::path::PathBuf;
use std::sync::{Mutex, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use super::{lock, now_millis, session_update, WireState};
use crate::domain::agents::acp::wire_transform::WireInjector;

const POLL_INTERVAL: Duration = Duration::from_millis(750);
/// Clock and write slack between OpenCode's timestamps and the wire's.
const CLOCK_SLACK_MS: i64 = 2_000;
/// OpenCode records the idle time before its last events reach the wire: a
/// reply ends only once it streamed nothing for this long.
const QUIET_MS: i64 = 750;
/// How long finished sub-agents may go without waking a reply before the
/// hold is released anyway.
const SETTLE_GRACE_MS: i64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Activity {
    busy: i64,
    idle: i64,
}

impl Activity {
    fn is_idle(self) -> bool {
        self.idle >= self.busy
    }
}

#[derive(Debug, PartialEq)]
enum Boundary {
    ReplyEnded { work_pending: bool },
    WorkSettled,
}

/// What the state asks the database, and what to send once it answers.
fn boundary(state: &WireState, activity: Activity, now: i64) -> Option<Boundary> {
    if !activity.is_idle() {
        return None;
    }
    if let Some(since) = state.detached_reply_since {
        let quiet = state
            .detached_reply_seen
            .is_none_or(|seen| now - seen >= QUIET_MS);
        return (quiet && activity.idle + CLOCK_SLACK_MS >= since).then_some(
            Boundary::ReplyEnded {
                work_pending: state.work_pending_after_reply(),
            },
        );
    }
    let settled = state.settled_at?;
    (state.work_pending && now - settled >= SETTLE_GRACE_MS).then_some(Boundary::WorkSettled)
}

impl WireState {
    fn wants_activity(&self) -> Option<String> {
        let waiting =
            self.detached_reply_since.is_some() || (self.work_pending && self.settled_at.is_some());
        waiting.then(|| self.root_session.clone()).flatten()
    }

    fn work_pending_after_reply(&self) -> bool {
        self.work_pending && self.settled_at.is_none()
    }

    /// The messages that tell the host about `boundary`.
    fn apply(&mut self, boundary: &Boundary) -> Vec<Value> {
        let session = Value::String(self.root_session.clone().unwrap_or_default());
        match boundary {
            Boundary::ReplyEnded { work_pending } => {
                self.detached_reply_since = None;
                self.detached_reply_seen = None;
                let mut update = json!({
                    "sessionUpdate": "usage_update",
                    "_meta": { "cadencr": {
                        "detachedReplyEnded": true,
                        "backgroundWorkPending": work_pending,
                    } },
                });
                if let Some((used, size)) = &self.last_usage {
                    update["used"] = used.clone();
                    update["size"] = size.clone();
                }
                let mut messages = vec![session_update(session.clone(), update)];
                if !work_pending && self.work_pending {
                    // The host ends only a reply that streamed text; one made
                    // of tool calls alone ends with the work it was held for.
                    messages.push(self.settle(session));
                }
                messages
            }
            Boundary::WorkSettled => vec![self.settle(session)],
        }
    }

    fn settle(&mut self, session: Value) -> Value {
        self.work_pending = false;
        self.settled_at = None;
        session_update(
            session,
            json!({
                "sessionUpdate": "session_info_update",
                "_meta": { "cadencr": { "backgroundWorkPending": false } },
            }),
        )
    }
}

pub(super) fn spawn_watcher(
    state: Weak<Mutex<WireState>>,
    database: PathBuf,
    injector: WireInjector,
) {
    tokio::spawn(async move {
        let mut reader = ActivityReader::new(database);
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let Some(shared) = state.upgrade() else {
                return;
            };
            let session = lock(&shared).wants_activity();
            let Some(session) = session else {
                continue;
            };
            let Some(activity) = reader.read(&session).await else {
                continue;
            };
            let messages = {
                let mut state = lock(&shared);
                boundary(&state, activity, now_millis())
                    .map(|boundary| state.apply(&boundary))
                    .unwrap_or_default()
            };
            drop(shared);
            for message in messages {
                if !injector.send_to_client(message).await {
                    return;
                }
            }
        }
    });
}

/// Read-only access to OpenCode's session table, opened on first use.
struct ActivityReader {
    database: PathBuf,
    pool: Option<SqlitePool>,
    reported_failure: bool,
}

impl ActivityReader {
    fn new(database: PathBuf) -> Self {
        Self {
            database,
            pool: None,
            reported_failure: false,
        }
    }

    async fn read(&mut self, session: &str) -> Option<Activity> {
        let read = match self.query(session).await {
            Ok(Some(activity)) => Ok(activity),
            Ok(None) => Err(format!(
                "session {session} has no busy/idle times (missing row, or an OpenCode build \
                 older than 2.3)"
            )),
            Err(error) => Err(error.to_string()),
        };
        match read {
            Ok(activity) => {
                self.reported_failure = false;
                Some(activity)
            }
            Err(error) => {
                // A locked database or a row not written yet recovers on a
                // later poll; report once per failure streak, the hold stays
                // until then.
                if !self.reported_failure {
                    tracing::warn!(
                        %error,
                        database = %self.database.display(),
                        "cannot read OpenCode session activity"
                    );
                    self.reported_failure = true;
                }
                None
            }
        }
    }

    async fn query(&mut self, session: &str) -> Result<Option<Activity>, sqlx::Error> {
        let pool = match &self.pool {
            Some(pool) => pool.clone(),
            None => {
                let options = SqliteConnectOptions::new()
                    .filename(&self.database)
                    .read_only(true)
                    .busy_timeout(Duration::from_millis(500))
                    .pragma("query_only", "true");
                let pool = SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect_with(options)
                    .await?;
                self.pool = Some(pool.clone());
                pool
            }
        };
        let row = sqlx::query("SELECT time_busy, time_idle FROM session_v2 WHERE id = ?")
            .bind(session)
            .fetch_optional(&pool)
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let busy: Option<i64> = row.try_get("time_busy")?;
        let idle: Option<i64> = row.try_get("time_idle")?;
        Ok(match (busy, idle) {
            (Some(busy), Some(idle)) => Some(Activity { busy, idle }),
            _ => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{boundary, Activity, Boundary, CLOCK_SLACK_MS, QUIET_MS, SETTLE_GRACE_MS};
    use crate::domain::agents::opencode::acp::v2::wire::WireState;

    fn idle_at(idle: i64) -> Activity {
        Activity {
            busy: idle - 10,
            idle,
        }
    }

    #[test]
    fn a_detached_reply_ends_once_the_session_went_idle_after_it_started() {
        let state = WireState {
            root_session: Some("root".into()),
            detached_reply_since: Some(10_000),
            ..WireState::default()
        };
        let busy = Activity {
            busy: 10_000,
            idle: 9_000,
        };
        assert_eq!(boundary(&state, busy, 11_000), None);
        let stale = idle_at(10_000 - CLOCK_SLACK_MS - 1);
        assert_eq!(boundary(&state, stale, 11_000), None);
        assert_eq!(
            boundary(&state, idle_at(10_500), 11_000),
            Some(Boundary::ReplyEnded {
                work_pending: false
            })
        );
    }

    #[test]
    fn the_reply_keeps_the_hold_while_children_still_run() {
        let state = WireState {
            root_session: Some("root".into()),
            detached_reply_since: Some(10_000),
            work_pending: true,
            ..WireState::default()
        };
        assert_eq!(
            boundary(&state, idle_at(10_500), 11_000),
            Some(Boundary::ReplyEnded { work_pending: true })
        );
    }

    #[test]
    fn finished_children_without_a_reply_release_the_hold_after_a_grace() {
        let mut state = WireState {
            root_session: Some("root".into()),
            work_pending: true,
            settled_at: Some(20_000),
            ..WireState::default()
        };
        assert_eq!(boundary(&state, idle_at(20_000), 21_000), None);
        assert_eq!(
            boundary(&state, idle_at(20_000), 20_000 + SETTLE_GRACE_MS),
            Some(Boundary::WorkSettled)
        );
        let messages = state.apply(&Boundary::WorkSettled);
        assert!(!state.work_pending);
        assert_eq!(
            messages[0]["params"]["update"]["_meta"]["cadencr"]["backgroundWorkPending"],
            false
        );
    }

    #[test]
    fn an_ended_reply_restates_the_last_context_budget() {
        let mut state = WireState {
            root_session: Some("root".into()),
            detached_reply_since: Some(1),
            last_usage: Some((serde_json::json!(5), serde_json::json!(100))),
            ..WireState::default()
        };
        let messages = state.apply(&Boundary::ReplyEnded {
            work_pending: false,
        });
        assert_eq!(messages.len(), 1, "no hold to release");
        let update = &messages[0]["params"]["update"];
        assert_eq!(update["used"], 5);
        assert_eq!(update["size"], 100);
        assert_eq!(update["_meta"]["cadencr"]["detachedReplyEnded"], true);
        assert!(state.detached_reply_since.is_none());
    }

    #[test]
    fn a_reply_ends_only_after_it_stopped_streaming() {
        let state = WireState {
            root_session: Some("root".into()),
            detached_reply_since: Some(10_000),
            detached_reply_seen: Some(10_600),
            ..WireState::default()
        };
        assert_eq!(
            boundary(&state, idle_at(10_500), 10_600 + QUIET_MS - 1),
            None
        );
        assert!(boundary(&state, idle_at(10_500), 10_600 + QUIET_MS).is_some());
    }

    #[test]
    fn ending_the_reply_that_released_the_hold_also_settles_the_work() {
        let mut state = WireState {
            root_session: Some("root".into()),
            detached_reply_since: Some(1),
            work_pending: true,
            settled_at: Some(1),
            ..WireState::default()
        };
        let messages = state.apply(&Boundary::ReplyEnded {
            work_pending: false,
        });
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[1]["params"]["update"]["sessionUpdate"],
            "session_info_update"
        );
        assert!(!state.work_pending);
    }
}
