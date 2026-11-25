use serde::Serialize;
use std::future::Future;
use std::io::Write as _;
use std::time::{Duration, Instant};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// Marker line consumed by the Electron sidecar to drive the splash status.
/// One line, fixed prefix; keep the format stable with `parsePhaseLine`.
pub(crate) fn emit_phase(name: &str, detail: &str) {
    let detail = detail.replace(['\r', '\n'], " ");
    if detail.is_empty() {
        println!("CADENCR_PHASE {name}");
    } else {
        println!("CADENCR_PHASE {name} {detail}");
    }
    // Production pipes stdout into Electron. Flush explicitly so a long SQLite
    // statement cannot leave the user looking at the preceding phase.
    if let Err(error) = std::io::stdout().flush() {
        tracing::warn!("failed to flush startup progress: {error}");
    }
}

/// Details for the desktop splash. The stdout phase names also drive its watchdog.
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub(crate) enum StartupStep {
    CreateBackup { bytes: u64 },
    UpdateSchema,
    RebuildSearch,
    CheckIntegrity,
    ReclaimSpace { bytes: u64 },
    VerifyIntegrity,
}

impl StartupStep {
    fn phase(self) -> &'static str {
        match self {
            Self::CreateBackup { .. } => "backing_up",
            Self::UpdateSchema | Self::RebuildSearch => "migrating",
            Self::CheckIntegrity | Self::ReclaimSpace { .. } | Self::VerifyIntegrity => {
                "compacting_database"
            }
        }
    }

    fn detail(self, elapsed: Option<Duration>) -> String {
        let progress =
            serde_json::json!({ "operation": self, "elapsed": elapsed.map(|time| time.as_secs()) });
        format!("@progress {progress}")
    }
}

/// Keep the watchdog live while SQLite runs. The desktop formats the operation,
/// byte count and elapsed seconds in the user's language.
pub(crate) async fn run_phase<T>(step: StartupStep, future: impl Future<Output = T>) -> T {
    emit_phase(step.phase(), &step.detail(None));
    let started = Instant::now();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return result,
            _ = heartbeat.tick() => emit_phase(step.phase(), &step.detail(Some(started.elapsed()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_preserves_the_operation_size_and_elapsed_seconds() {
        let step = StartupStep::CreateBackup { bytes: 8192 };
        assert_eq!(step.phase(), "backing_up");
        let detail = step.detail(Some(Duration::from_secs(125)));
        let frame: serde_json::Value =
            serde_json::from_str(detail.strip_prefix("@progress ").unwrap()).unwrap();
        assert_eq!(
            frame,
            serde_json::json!({"operation":{"step":"create_backup","bytes":8192}, "elapsed":125})
        );
    }
}
