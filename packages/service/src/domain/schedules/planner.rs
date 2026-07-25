//! Turns a recurrence rule into the concrete `next_run_at` instant the poll
//! loop scans for, and decides what to do when that instant has already passed.

use chrono::{DateTime, Duration, Utc};

use super::recurrence::{from_storage, to_storage, Recurrence};
use crate::error::AppError;

/// How late a run may be and still fire. Reopening the app after lunch should
/// deliver the 09:00 message you missed; reopening after a fortnight should
/// not deliver fourteen of them, nor one that is hopelessly out of context.
pub const CATCH_UP_GRACE: Duration = Duration::hours(24);

/// What the scheduler should do with a claimed row.
#[derive(Debug, PartialEq, Eq)]
pub enum DueAction {
    /// Deliver it, then roll the rule forward.
    Run,
    /// Too far past to be useful — roll forward without delivering.
    Skip,
}

/// The first `next_run_at` for a freshly saved schedule.
///
/// One-shot schedules carry their instant explicitly; repeating ones derive it
/// from the rule, so "every day at 09:00" saved at 10:00 lands on tomorrow
/// rather than firing immediately.
pub fn initial_next_run(
    recurrence: &Recurrence,
    run_at: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Option<String>, AppError> {
    if recurrence.kind.repeats() {
        return Ok(recurrence.next_after(now).map(to_storage));
    }
    let raw = run_at
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("run_at is required for a one-off schedule".into()))?;
    let instant = DateTime::parse_from_rfc3339(raw)
        .map_err(|_| AppError::BadRequest(format!("invalid run_at '{raw}'; expected ISO-8601")))?
        .with_timezone(&Utc);
    if instant <= now {
        return Err(AppError::BadRequest(
            "pick a time in the future for a one-off schedule".into(),
        ));
    }
    Ok(Some(to_storage(instant)))
}

/// Whether a due run is fresh enough to deliver.
pub fn due_action(scheduled_for: Option<DateTime<Utc>>, now: DateTime<Utc>) -> DueAction {
    match scheduled_for {
        Some(instant) if now - instant > CATCH_UP_GRACE => DueAction::Skip,
        _ => DueAction::Run,
    }
}

/// Where the rule points after a run.
///
/// Wall-clock rules advance from the slot they just filled, so a late run still
/// lands back on the grid (a 09:00 daily delivered at 09:04 is next due at
/// 09:00 tomorrow, not 09:04). Interval rules advance from *now* instead: an
/// interval measures the gap between runs, and anchoring to a missed slot would
/// fire a burst catching up. One-shot rules point nowhere — that is what marks
/// them finished.
pub fn next_run_after_run(
    recurrence: &Recurrence,
    scheduled_for: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Option<String> {
    if !recurrence.kind.repeats() {
        return None;
    }
    let anchor = match recurrence.interval_seconds {
        Some(_) => now,
        None => scheduled_for.unwrap_or(now),
    };
    let mut next = recurrence.next_after(anchor)?;
    // A rule whose anchor is in the past can still resolve to a past instant
    // (a daily missed by two days). Walk it forward so we never hand the poll
    // loop a row that is instantly due again.
    let mut guard = 0;
    while next <= now && guard < 512 {
        next = recurrence.next_after(next)?;
        guard += 1;
    }
    Some(to_storage(next))
}

/// Recompute `next_run_at` when a paused schedule is resumed.
///
/// Repeating rules re-derive from now, so resuming a daily message next week
/// doesn't fire the days you were paused. A one-shot keeps the instant it was
/// saved with — it is still the message you asked for, and the catch-up grace
/// decides whether it is too stale to send.
pub fn next_run_on_resume(
    recurrence: &Recurrence,
    stored_next_run_at: Option<&str>,
    now: DateTime<Utc>,
) -> Option<String> {
    if recurrence.kind.repeats() {
        return recurrence.next_after(now).map(to_storage);
    }
    stored_next_run_at.map(str::to_string)
}

/// Parse a stored `next_run_at` (or the ISO form the projection returns).
pub fn parse_instant(raw: &str) -> Option<DateTime<Utc>> {
    from_storage(raw).or_else(|| {
        DateTime::parse_from_rfc3339(raw)
            .ok()
            .map(|instant| instant.with_timezone(&Utc))
    })
}

#[cfg(test)]
mod tests {
    use super::super::recurrence::RecurrenceKind;
    use super::*;

    fn utc(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn daily(time: &str) -> Recurrence {
        Recurrence::parse(
            RecurrenceKind::Daily,
            None,
            Some(time.into()),
            None,
            None,
            Some("UTC".into()),
        )
        .unwrap()
    }

    fn interval(seconds: i64) -> Recurrence {
        Recurrence::parse(
            RecurrenceKind::Interval,
            Some(seconds),
            None,
            None,
            None,
            None,
        )
        .unwrap()
    }

    fn once() -> Recurrence {
        Recurrence::parse(RecurrenceKind::Once, None, None, None, None, None).unwrap()
    }

    #[test]
    fn initial_run_for_a_repeating_rule_comes_from_the_rule() {
        let next = initial_next_run(&daily("09:00"), None, utc("2026-07-24T10:00:00Z")).unwrap();
        assert_eq!(next.as_deref(), Some("2026-07-25 09:00:00"));
    }

    #[test]
    fn one_off_requires_a_future_instant() {
        let now = utc("2026-07-24T10:00:00Z");
        assert_eq!(
            initial_next_run(&once(), Some("2026-07-24T11:00:00Z"), now)
                .unwrap()
                .as_deref(),
            Some("2026-07-24 11:00:00")
        );
        assert!(initial_next_run(&once(), None, now).is_err());
        assert!(initial_next_run(&once(), Some("2026-07-24T09:00:00Z"), now).is_err());
        assert!(initial_next_run(&once(), Some("not a time"), now).is_err());
    }

    #[test]
    fn runs_inside_the_grace_window_still_fire() {
        let now = utc("2026-07-24T10:00:00Z");
        assert_eq!(
            due_action(Some(utc("2026-07-23T11:00:00Z")), now),
            DueAction::Run
        );
        assert_eq!(
            due_action(Some(utc("2026-07-23T09:00:00Z")), now),
            DueAction::Skip
        );
        // A row with no recorded slot is treated as fresh rather than dropped.
        assert_eq!(due_action(None, now), DueAction::Run);
    }

    // The point of anchoring wall-clock rules to the slot: a run delivered a
    // few minutes late must not drag the whole series later.
    #[test]
    fn a_late_daily_run_stays_on_its_grid() {
        let next = next_run_after_run(
            &daily("09:00"),
            Some(utc("2026-07-24T09:00:00Z")),
            utc("2026-07-24T09:04:00Z"),
        );
        assert_eq!(next.as_deref(), Some("2026-07-25 09:00:00"));
    }

    // ...and a daily missed for days rolls to the next real slot rather than
    // handing back an instantly-due instant for every missed day.
    #[test]
    fn a_long_missed_daily_rolls_forward_once() {
        let next = next_run_after_run(
            &daily("09:00"),
            Some(utc("2026-07-20T09:00:00Z")),
            utc("2026-07-24T10:00:00Z"),
        );
        assert_eq!(next.as_deref(), Some("2026-07-25 09:00:00"));
    }

    // Intervals measure the gap between runs, so a long outage must not queue
    // one run per missed period.
    #[test]
    fn an_interval_restarts_from_now_not_from_the_missed_slot() {
        let next = next_run_after_run(
            &interval(3600),
            Some(utc("2026-07-20T09:00:00Z")),
            utc("2026-07-24T10:00:00Z"),
        );
        assert_eq!(next.as_deref(), Some("2026-07-24 11:00:00"));
    }

    #[test]
    fn a_one_off_points_nowhere_once_it_has_run() {
        assert_eq!(
            next_run_after_run(
                &once(),
                Some(utc("2026-07-24T09:00:00Z")),
                utc("2026-07-24T09:00:01Z")
            ),
            None
        );
    }

    #[test]
    fn resuming_re_derives_repeating_rules_but_keeps_a_one_off() {
        let now = utc("2026-07-24T10:00:00Z");
        assert_eq!(
            next_run_on_resume(&daily("09:00"), Some("2026-07-01 09:00:00"), now).as_deref(),
            Some("2026-07-25 09:00:00")
        );
        assert_eq!(
            next_run_on_resume(&once(), Some("2026-07-30 09:00:00"), now).as_deref(),
            Some("2026-07-30 09:00:00")
        );
    }

    #[test]
    fn instants_parse_from_both_storage_and_iso_forms() {
        assert_eq!(
            parse_instant("2026-07-24 09:00:00"),
            Some(utc("2026-07-24T09:00:00Z"))
        );
        assert_eq!(
            parse_instant("2026-07-24T09:00:00Z"),
            Some(utc("2026-07-24T09:00:00Z"))
        );
        assert_eq!(parse_instant("later"), None);
    }
}
