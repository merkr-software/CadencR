use crate::domain::settings_store::{self, file, Scope};

const ENABLED_KEY: &str = "retention_compact_archived_enabled";
const DAYS_KEY: &str = "retention_compact_archived_days";
pub(super) const DEFAULT_DAYS: i64 = 30;

/// The configured window, or `None` when the pass must not run.
pub(super) fn window_days() -> Option<i64> {
    // Fail closed: a malformed settings document must never re-enable the only
    // maintenance pass that discards bytes.
    let window = settings_store::global_inspect_document(|doc| {
        if file::read_scalar(doc, Scope::Workspace, ENABLED_KEY)?.as_deref() != Some("true") {
            return Ok(None);
        }
        let days = file::read_scalar(doc, Scope::Workspace, DAYS_KEY)?;
        let days = days.map(|days| days.trim().parse().expect("validated retention window"));
        Ok(Some(days.unwrap_or(DEFAULT_DAYS)))
    });
    match window {
        Ok(days) => days,
        Err(error) => {
            tracing::warn!(%error, "retention: skipping compaction this sweep");
            None
        }
    }
}

pub(super) enum PolicyGuard {
    Configured {
        accepted_generation: u64,
    },
    #[cfg(test)]
    Test(fn(i64) -> bool),
}

impl PolicyGuard {
    pub(super) fn configured() -> Option<(i64, Self)> {
        let generation = settings_store::generation::global();
        let days = window_days()?;
        (generation == settings_store::generation::global()).then_some((
            days,
            Self::Configured {
                accepted_generation: generation,
            },
        ))
    }

    #[cfg(test)]
    pub(super) fn testing(check: fn(i64) -> bool) -> Self {
        Self::Test(check)
    }

    pub(super) fn is_current(&mut self, days: i64) -> bool {
        match self {
            Self::Configured {
                accepted_generation,
            } => {
                let mut observed_generation = settings_store::generation::global();
                if *accepted_generation == observed_generation {
                    return true;
                }

                // Sidebar width, theme, and every other workspace setting share
                // the same coarse generation counter. Re-read the retention
                // policy before cancelling so an unrelated setting write (for
                // example a window resize persisting sidebar width) cannot stop
                // a cleanup sweep. Once accepted, remember the new generation
                // so later batches stay on the cheap in-memory path.
                // Retry if a setting write overlaps the snapshot. This avoids
                // treating a rapid series of unrelated sidebar-width writes as
                // a retention-policy cancellation while still requiring one
                // stable read before the next lossy batch.
                loop {
                    let current_days = window_days();
                    let generation_after_read = settings_store::generation::global();
                    if observed_generation != generation_after_read {
                        observed_generation = generation_after_read;
                        continue;
                    }
                    if current_days != Some(days) {
                        return false;
                    }
                    *accepted_generation = generation_after_read;
                    return true;
                }
            }
            #[cfg(test)]
            Self::Test(check) => check(days),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unrelated_workspace_setting_changes_do_not_cancel_cleanup() {
        settings_store::global_set(ENABLED_KEY, "true")
            .await
            .unwrap();
        settings_store::global_set(DAYS_KEY, "30").await.unwrap();
        let (days, mut guard) = PolicyGuard::configured().expect("enabled policy");

        settings_store::global_set("sidebar_left_width", "420")
            .await
            .unwrap();
        assert!(guard.is_current(days));

        settings_store::global_set(DAYS_KEY, "60").await.unwrap();
        assert!(!guard.is_current(days));
    }
}
