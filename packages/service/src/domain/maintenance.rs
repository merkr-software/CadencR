//! Background storage maintenance.
//!
//! Cadencr's database grows without bound because every agent turn appends tool
//! calls and results. This job keeps that historical data under control.
//!
//! Passes are resumable and best-effort: failures cost disk space, not correctness.
//!
//! Passes are deliberately ordered cheapest-and-safest first:
//!
//! 1. [`tool_output_backfill`] — lossless. Drops `tool_call` output copies whose
//!    `tool_result` row holds the same bytes. Not gated on any user setting or
//!    retention window, because deleting a verified duplicate can't lose
//!    anything.
//! 2. [`image_backfill`] — lossless. Moves inline base64 images onto disk,
//!    leaving a reference. The bytes are still there, just not in SQLite.
//! 3. [`retention`] — the only lossy pass, and so the only one behind a user
//!    setting and a retention window. Trims oversized tool payloads on features
//!    archived long enough ago. It runs last so the lossless passes have
//!    already shrunk whatever they can, leaving it less to trim.
//!
//! Background passes run candidate scans on the read pool and touch the write
//! pool only for mutating updates, pausing and yielding between items so they
//! never starve live writers. Their progress appears in the desktop's global
//! sidebar.

pub mod compaction;
pub mod database_compaction;
pub mod image_backfill;
pub mod retention;
pub mod routes;
mod scheduler;
pub mod state;
pub mod tool_output_backfill;

pub use scheduler::spawn;

use crate::shared::discard::IgnoreClosed;
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageMaintenanceTask {
    Optimization,
    Cleanup,
}

/// User-visible lifecycle for initial lossless optimization and later cleanup.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum StorageMaintenanceEvent {
    Started {
        task: StorageMaintenanceTask,
        completed: u64,
        total: u64,
    },
    Progress {
        task: StorageMaintenanceTask,
        completed: u64,
        total: u64,
    },
    Completed {
        task: StorageMaintenanceTask,
        completed: u64,
        total: u64,
    },
    Cancelled {
        task: StorageMaintenanceTask,
        completed: u64,
        total: u64,
    },
    Failed {
        task: StorageMaintenanceTask,
        completed: u64,
        total: u64,
    },
}

/// Broadcast plus a reconnect snapshot for a sweep that is currently running.
#[derive(Clone)]
pub struct StorageMaintenanceBroadcaster {
    tx: broadcast::Sender<StorageMaintenanceEvent>,
    active: Arc<RwLock<Option<StorageMaintenanceEvent>>>,
    running: Arc<AtomicBool>,
}

pub(super) struct StorageMaintenanceRunGuard {
    running: Arc<AtomicBool>,
}

impl Drop for StorageMaintenanceRunGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

impl StorageMaintenanceBroadcaster {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            active: Arc::new(RwLock::new(None)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StorageMaintenanceEvent> {
        self.tx.subscribe()
    }

    pub fn active(&self) -> Option<StorageMaintenanceEvent> {
        match self.active.read() {
            Ok(active) => active.clone(),
            Err(poisoned) => {
                tracing::warn!("storage maintenance state lock was poisoned; recovering");
                poisoned.into_inner().clone()
            }
        }
    }

    pub fn emit(&self, event: StorageMaintenanceEvent) {
        let active = matches!(
            event,
            StorageMaintenanceEvent::Started { .. } | StorageMaintenanceEvent::Progress { .. }
        )
        .then(|| event.clone());
        match self.active.write() {
            Ok(mut stored) => *stored = active,
            Err(poisoned) => {
                tracing::warn!("storage maintenance state lock was poisoned; recovering");
                *poisoned.into_inner() = active;
            }
        }
        // No connected desktop is a normal state during startup and shutdown.
        self.tx.send(event).ignore_closed();
    }

    pub(super) fn try_begin_run(&self) -> Option<StorageMaintenanceRunGuard> {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            .then(|| StorageMaintenanceRunGuard {
                running: Arc::clone(&self.running),
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OptimizationPlan {
    high_water: i64,
    tool_start: i64,
    image_start: i64,
}

impl OptimizationPlan {
    async fn load(pool: &SqlitePool) -> Result<Self, sqlx::Error> {
        let high_water = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(id) FROM agent_messages")
            .fetch_one(pool)
            .await?
            .unwrap_or(0);
        Ok(Self {
            high_water,
            tool_start: state::get_i64(pool, state::TOOL_OUTPUT_BACKFILL_CURSOR, 0).await,
            image_start: state::get_i64(pool, state::IMAGE_BACKFILL_CURSOR, 0).await,
        })
    }

    fn total(self) -> u64 {
        remaining(self.tool_start, self.high_water) + remaining(self.image_start, self.high_water)
    }

    fn completed(self, tool_cursor: i64, image_cursor: i64) -> u64 {
        advanced(self.tool_start, tool_cursor, self.high_water)
            + advanced(self.image_start, image_cursor, self.high_water)
    }
}

fn remaining(start: i64, high_water: i64) -> u64 {
    (high_water.max(0) - start.max(0)).max(0) as u64
}

fn advanced(start: i64, cursor: i64, high_water: i64) -> u64 {
    remaining(start, cursor.min(high_water))
}

/// Run every maintenance pass once.
pub async fn run_once(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
) {
    let optimized = run_lossless_optimization(read_pool, write_pool, Some(events)).await;
    let compacted = run_cleanup(read_pool, write_pool, events).await;
    request_database_compaction(write_pool, optimized.saturating_add(compacted)).await;
}

pub(super) async fn run_lossless_optimization(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: Option<&StorageMaintenanceBroadcaster>,
) -> u64 {
    let show_optimization = state::get(read_pool, state::INITIAL_OPTIMIZATION_COMPLETED)
        .await
        .as_deref()
        != Some("1");
    let optimization = if show_optimization {
        match OptimizationPlan::load(read_pool).await {
            Ok(plan) => Some(plan),
            Err(error) => {
                tracing::warn!("failed to prepare initial storage optimization: {error}");
                if let Some(events) = events {
                    events.emit(StorageMaintenanceEvent::Failed {
                        task: StorageMaintenanceTask::Optimization,
                        completed: 0,
                        total: 0,
                    });
                }
                None
            }
        }
    } else {
        None
    };
    if let Some(plan) = optimization.filter(|plan| plan.total() > 0) {
        if let Some(events) = events {
            events.emit(StorageMaintenanceEvent::Started {
                task: StorageMaintenanceTask::Optimization,
                completed: 0,
                total: plan.total(),
            });
        }
    }

    let stripped = tool_output_backfill::run_with_progress(read_pool, write_pool, |cursor| {
        emit_optimization_progress(events, optimization, cursor, None);
    })
    .await;
    if stripped > 0 {
        tracing::info!(
            stripped,
            "storage maintenance: duplicated tool output removed"
        );
    }
    let tool_cursor = state::get_i64(read_pool, state::TOOL_OUTPUT_BACKFILL_CURSOR, 0).await;
    let offloaded = image_backfill::run_with_progress(read_pool, write_pool, |cursor| {
        emit_optimization_progress(events, optimization, tool_cursor, Some(cursor));
    })
    .await;
    if offloaded > 0 {
        tracing::info!(
            offloaded,
            "storage maintenance: inline images moved to disk"
        );
    }
    finish_initial_optimization(read_pool, write_pool, events, optimization).await;
    stripped.saturating_add(offloaded)
}

pub(super) async fn run_cleanup_once(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
) -> u64 {
    let compacted = run_cleanup(read_pool, write_pool, events).await;
    request_database_compaction(write_pool, compacted).await;
    compacted
}

async fn run_cleanup(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
) -> u64 {
    let compacted = retention::run(read_pool, write_pool, events).await;
    if compacted > 0 {
        tracing::info!(
            compacted,
            "storage maintenance: archived features compacted"
        );
    }
    compacted
}

pub(super) async fn request_database_compaction(write_pool: &SqlitePool, changed: u64) {
    if changed > 0 {
        // `VACUUM` cannot run while the service is serving reads and writes.
        // Request one for the next startup, where only the write pool exists.
        state::set(write_pool, state::DATABASE_COMPACTION_REQUESTED, "1").await;
    }
}

fn emit_optimization_progress(
    events: Option<&StorageMaintenanceBroadcaster>,
    plan: Option<OptimizationPlan>,
    tool_cursor: i64,
    image_cursor: Option<i64>,
) {
    let Some(plan) = plan.filter(|plan| plan.total() > 0) else {
        return;
    };
    if let Some(events) = events {
        events.emit(StorageMaintenanceEvent::Progress {
            task: StorageMaintenanceTask::Optimization,
            completed: plan.completed(tool_cursor, image_cursor.unwrap_or(plan.image_start)),
            total: plan.total(),
        });
    }
}

async fn finish_initial_optimization(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: Option<&StorageMaintenanceBroadcaster>,
    plan: Option<OptimizationPlan>,
) {
    let Some(plan) = plan else { return };
    let tool_cursor = state::get_i64(read_pool, state::TOOL_OUTPUT_BACKFILL_CURSOR, 0).await;
    let image_cursor = state::get_i64(read_pool, state::IMAGE_BACKFILL_CURSOR, 0).await;
    let completed = plan.completed(tool_cursor, image_cursor);
    let total = plan.total();
    if completed >= total {
        state::set(write_pool, state::INITIAL_OPTIMIZATION_COMPLETED, "1").await;
        if let Some(events) = events.filter(|_| total > 0) {
            events.emit(StorageMaintenanceEvent::Completed {
                task: StorageMaintenanceTask::Optimization,
                completed,
                total,
            });
        }
    } else if let Some(events) = events.filter(|_| total > 0) {
        events.emit(StorageMaintenanceEvent::Failed {
            task: StorageMaintenanceTask::Optimization,
            completed,
            total,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimization_plan_combines_both_cursor_ranges() {
        let plan = OptimizationPlan {
            high_water: 100,
            tool_start: 20,
            image_start: 40,
        };

        assert_eq!(plan.total(), 140);
        assert_eq!(plan.completed(60, 40), 40);
        assert_eq!(plan.completed(100, 80), 120);
        assert_eq!(plan.completed(120, 120), 140);
    }

    #[test]
    fn optimization_plan_ignores_cursors_past_the_current_high_water() {
        let plan = OptimizationPlan {
            high_water: 100,
            tool_start: 120,
            image_start: 140,
        };

        assert_eq!(plan.total(), 0);
        assert_eq!(plan.completed(150, 160), 0);
    }

    #[test]
    fn broadcaster_snapshots_latest_running_progress_only() {
        let events = StorageMaintenanceBroadcaster::new(4);
        events.emit(StorageMaintenanceEvent::Started {
            task: StorageMaintenanceTask::Optimization,
            completed: 0,
            total: 10,
        });
        events.emit(StorageMaintenanceEvent::Progress {
            task: StorageMaintenanceTask::Optimization,
            completed: 4,
            total: 10,
        });
        assert_eq!(
            events.active(),
            Some(StorageMaintenanceEvent::Progress {
                task: StorageMaintenanceTask::Optimization,
                completed: 4,
                total: 10,
            })
        );

        events.emit(StorageMaintenanceEvent::Completed {
            task: StorageMaintenanceTask::Optimization,
            completed: 10,
            total: 10,
        });
        assert!(events.active().is_none());
    }

    #[test]
    fn broadcaster_allows_only_one_maintenance_run_at_a_time() {
        let events = StorageMaintenanceBroadcaster::new(4);
        let run = events.try_begin_run().expect("first run");

        assert!(events.try_begin_run().is_none());

        drop(run);
        assert!(events.try_begin_run().is_some());
    }
}
