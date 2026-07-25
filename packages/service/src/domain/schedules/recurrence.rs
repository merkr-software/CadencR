//! Structured recurrence rules and the "when does this next fire?" arithmetic.
//!
//! Deliberately not cron. The rules users actually want — every N minutes,
//! every weekday at 09:00, the 1st of the month — are expressible without a
//! cron parser, and a structured rule can be rendered back into a sentence and
//! an editable form. The cost is that we own the calendar arithmetic, which is
//! why it lives here with its own tests.
//!
//! Wall-clock rules (`daily`/`weekly`/`monthly`) are interpreted in the
//! schedule's own IANA timezone, so "every day at 09:00" stays at 09:00 across
//! a DST transition instead of drifting an hour. Interval rules are pure
//! duration arithmetic and ignore the timezone entirely.

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::AppError;

/// Upper bound on the day-by-day search for the next matching wall-clock day.
/// The widest rule is monthly (at most 31 days between matches), so two months
/// of headroom means a miss is a bug, not a tight bound.
const MAX_DAY_SCAN: i64 = 62;

/// Smallest interval we accept, matching the custom-action scheduler's floor.
/// Anything tighter is a runaway loop, not a schedule.
pub const MIN_INTERVAL_SECONDS: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecurrenceKind {
    Once,
    Interval,
    Daily,
    Weekly,
    Monthly,
}

impl RecurrenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Interval => "interval",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw {
            "once" => Ok(Self::Once),
            "interval" => Ok(Self::Interval),
            "daily" => Ok(Self::Daily),
            "weekly" => Ok(Self::Weekly),
            "monthly" => Ok(Self::Monthly),
            other => Err(AppError::BadRequest(format!(
                "unknown recurrence kind '{other}'"
            ))),
        }
    }

    /// Whether the rule can fire more than once.
    pub fn repeats(self) -> bool {
        !matches!(self, Self::Once)
    }
}

/// A validated recurrence rule. Construct via [`Recurrence::parse`] so the
/// per-kind fields can never disagree with the kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Recurrence {
    pub kind: RecurrenceKind,
    /// `interval`: seconds between runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_seconds: Option<i64>,
    /// `daily` / `weekly` / `monthly`: local wall-clock time as `HH:MM`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_of_day: Option<String>,
    /// `weekly`: ISO weekdays, 1 = Monday .. 7 = Sunday, ascending and unique.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<i64>>,
    /// `monthly`: 1-31, clamped to the last day of shorter months.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<i64>,
    /// IANA zone the wall-clock fields are read in.
    pub timezone: String,
}

/// Wall-clock time of day, already split and range-checked.
#[derive(Debug, Clone, Copy)]
struct TimeOfDay {
    hour: u32,
    minute: u32,
}

impl Recurrence {
    /// Validate a rule, rejecting fields that don't belong to the kind rather
    /// than silently ignoring them — a "weekly" rule with no weekdays would
    /// otherwise never fire and look broken at runtime instead of at save time.
    pub fn parse(
        kind: RecurrenceKind,
        interval_seconds: Option<i64>,
        time_of_day: Option<String>,
        weekdays: Option<Vec<i64>>,
        day_of_month: Option<i64>,
        timezone: Option<String>,
    ) -> Result<Self, AppError> {
        let timezone = timezone.unwrap_or_else(|| "UTC".to_string());
        timezone.parse::<Tz>().map_err(|_| {
            AppError::BadRequest(format!(
                "unknown timezone '{timezone}'; expected an IANA name"
            ))
        })?;

        let interval_seconds = match kind {
            RecurrenceKind::Interval => Some(validate_interval(interval_seconds)?),
            _ => None,
        };
        let time_of_day = match kind {
            RecurrenceKind::Once | RecurrenceKind::Interval => None,
            _ => Some(normalized_time_of_day(time_of_day.as_deref())?),
        };
        let weekdays = match kind {
            RecurrenceKind::Weekly => Some(validate_weekdays(weekdays)?),
            _ => None,
        };
        let day_of_month = match kind {
            RecurrenceKind::Monthly => Some(validate_day_of_month(day_of_month)?),
            _ => None,
        };

        Ok(Self {
            kind,
            interval_seconds,
            time_of_day,
            weekdays,
            day_of_month,
            timezone,
        })
    }

    /// Rebuild a rule from its stored columns. Storage is the output of
    /// [`Recurrence::parse`], so the same validation applies and a row that
    /// somehow drifted is surfaced as an error rather than silently mis-firing.
    pub fn from_row(
        kind: &str,
        interval_seconds: Option<i64>,
        time_of_day: Option<String>,
        weekdays: Option<String>,
        day_of_month: Option<i64>,
        timezone: String,
    ) -> Result<Self, AppError> {
        let parsed_weekdays = weekdays
            .as_deref()
            .filter(|raw| !raw.trim().is_empty())
            .map(|raw| {
                raw.split(',')
                    .map(|day| {
                        day.trim().parse::<i64>().map_err(|_| {
                            AppError::Internal(format!("corrupt weekday list '{raw}'"))
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        Self::parse(
            RecurrenceKind::parse(kind)?,
            interval_seconds,
            time_of_day,
            parsed_weekdays,
            day_of_month,
            Some(timezone),
        )
    }

    /// The weekday list in its stored CSV form.
    pub fn weekdays_csv(&self) -> Option<String> {
        self.weekdays.as_ref().map(|days| {
            days.iter()
                .map(|day| day.to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
    }

    /// The first instant strictly after `after` at which this rule fires, or
    /// `None` for a one-shot rule (whose single instant is stored directly).
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self.kind {
            RecurrenceKind::Once => None,
            RecurrenceKind::Interval => Some(
                after + Duration::seconds(self.interval_seconds.unwrap_or(MIN_INTERVAL_SECONDS)),
            ),
            _ => self.next_wall_clock_after(after),
        }
    }

    fn next_wall_clock_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let tz: Tz = self.timezone.parse().ok()?;
        let time = self.parsed_time_of_day()?;
        let local_now = after.with_timezone(&tz);
        let mut day = local_now.date_naive();
        for _ in 0..MAX_DAY_SCAN {
            if self.day_matches(day) {
                if let Some(candidate) = resolve_local(tz, day, time) {
                    if candidate > after {
                        return Some(candidate);
                    }
                }
            }
            day = day.succ_opt()?;
        }
        None
    }

    fn parsed_time_of_day(&self) -> Option<TimeOfDay> {
        let raw = self.time_of_day.as_deref()?;
        let (hour, minute) = raw.split_once(':')?;
        Some(TimeOfDay {
            hour: hour.parse().ok()?,
            minute: minute.parse().ok()?,
        })
    }

    fn day_matches(&self, day: NaiveDate) -> bool {
        match self.kind {
            RecurrenceKind::Daily => true,
            RecurrenceKind::Weekly => self
                .weekdays
                .as_ref()
                .is_some_and(|days| days.contains(&(day.weekday().number_from_monday() as i64))),
            RecurrenceKind::Monthly => {
                let target = self.day_of_month.unwrap_or(1);
                // Clamp so "the 31st" still fires in February rather than
                // skipping every short month.
                day.day() as i64 == target.min(last_day_of_month(day) as i64)
            }
            _ => false,
        }
    }
}

/// Resolve a local wall-clock time to a UTC instant, absorbing DST oddities:
/// a time that doesn't exist (spring forward) rolls to the first instant after
/// the gap, and an ambiguous one (fall back) takes the earlier occurrence so
/// the rule fires once, not twice.
fn resolve_local(tz: Tz, day: NaiveDate, time: TimeOfDay) -> Option<DateTime<Utc>> {
    let naive = day.and_hms_opt(time.hour, time.minute, 0)?;
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(local) => Some(local.with_timezone(&Utc)),
        chrono::LocalResult::Ambiguous(earlier, _) => Some(earlier.with_timezone(&Utc)),
        chrono::LocalResult::None => {
            // Walk forward a minute at a time out of the gap (at most an hour
            // in every zone that has ever existed).
            (1..=120).find_map(|offset| {
                let shifted = naive + Duration::minutes(offset);
                match tz.from_local_datetime(&shifted) {
                    chrono::LocalResult::Single(local) => Some(local.with_timezone(&Utc)),
                    chrono::LocalResult::Ambiguous(earlier, _) => Some(earlier.with_timezone(&Utc)),
                    chrono::LocalResult::None => None,
                }
            })
        }
    }
}

fn last_day_of_month(day: NaiveDate) -> u32 {
    let (year, month) = (day.year(), day.month());
    let first_next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    first_next
        .and_then(|date| date.pred_opt())
        .map(|date| date.day())
        .unwrap_or(28)
}

fn validate_interval(interval_seconds: Option<i64>) -> Result<i64, AppError> {
    let seconds = interval_seconds.ok_or_else(|| {
        AppError::BadRequest("interval_seconds is required for an interval schedule".into())
    })?;
    if seconds < MIN_INTERVAL_SECONDS {
        return Err(AppError::BadRequest(format!(
            "the shortest supported interval is {MIN_INTERVAL_SECONDS} seconds"
        )));
    }
    Ok(seconds)
}

fn normalized_time_of_day(raw: Option<&str>) -> Result<String, AppError> {
    let raw = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("time_of_day (HH:MM) is required for this schedule".into())
        })?;
    let (hour, minute) = raw.split_once(':').ok_or_else(|| {
        AppError::BadRequest(format!("invalid time_of_day '{raw}'; expected HH:MM"))
    })?;
    let hour: u32 = hour
        .parse()
        .map_err(|_| AppError::BadRequest(format!("invalid hour in time_of_day '{raw}'")))?;
    let minute: u32 = minute
        .parse()
        .map_err(|_| AppError::BadRequest(format!("invalid minute in time_of_day '{raw}'")))?;
    if hour > 23 || minute > 59 {
        return Err(AppError::BadRequest(format!(
            "time_of_day '{raw}' is out of range"
        )));
    }
    Ok(format!("{hour:02}:{minute:02}"))
}

fn validate_weekdays(weekdays: Option<Vec<i64>>) -> Result<Vec<i64>, AppError> {
    let mut days = weekdays.unwrap_or_default();
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return Err(AppError::BadRequest(
            "pick at least one weekday for a weekly schedule".into(),
        ));
    }
    if days.iter().any(|day| !(1..=7).contains(day)) {
        return Err(AppError::BadRequest(
            "weekdays must be 1 (Monday) through 7 (Sunday)".into(),
        ));
    }
    Ok(days)
}

fn validate_day_of_month(day_of_month: Option<i64>) -> Result<i64, AppError> {
    let day = day_of_month.ok_or_else(|| {
        AppError::BadRequest("day_of_month is required for a monthly schedule".into())
    })?;
    if !(1..=31).contains(&day) {
        return Err(AppError::BadRequest(
            "day_of_month must be between 1 and 31".into(),
        ));
    }
    Ok(day)
}

/// A local wall-clock instant rendered as the UTC storage string, used when a
/// caller supplies an absolute one-shot time.
pub fn to_storage(instant: DateTime<Utc>) -> String {
    instant.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Parse a stored UTC timestamp (`YYYY-MM-DD HH:MM:SS`).
pub fn from_storage(raw: &str) -> Option<DateTime<Utc>> {
    chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|naive| Utc.from_utc_datetime(&naive))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn daily(time: &str, timezone: &str) -> Recurrence {
        Recurrence::parse(
            RecurrenceKind::Daily,
            None,
            Some(time.into()),
            None,
            None,
            Some(timezone.into()),
        )
        .unwrap()
    }

    #[test]
    fn interval_adds_its_duration() {
        let rule =
            Recurrence::parse(RecurrenceKind::Interval, Some(900), None, None, None, None).unwrap();
        assert_eq!(
            rule.next_after(utc("2026-07-24T10:00:00Z")),
            Some(utc("2026-07-24T10:15:00Z"))
        );
    }

    #[test]
    fn once_never_reschedules_itself() {
        let rule = Recurrence::parse(RecurrenceKind::Once, None, None, None, None, None).unwrap();
        assert_eq!(rule.next_after(utc("2026-07-24T10:00:00Z")), None);
    }

    #[test]
    fn daily_picks_today_then_rolls_to_tomorrow() {
        let rule = daily("09:00", "UTC");
        assert_eq!(
            rule.next_after(utc("2026-07-24T08:00:00Z")),
            Some(utc("2026-07-24T09:00:00Z"))
        );
        // Strictly after: the instant it just fired must not match again.
        assert_eq!(
            rule.next_after(utc("2026-07-24T09:00:00Z")),
            Some(utc("2026-07-25T09:00:00Z"))
        );
    }

    // The reason wall-clock rules carry a timezone at all: across a DST change
    // the local hour must hold, which means the UTC instant has to move.
    #[test]
    fn daily_holds_local_time_across_a_dst_transition() {
        let rule = daily("09:00", "Europe/Paris");
        // CET (UTC+1) before the spring-forward on 2026-03-29.
        assert_eq!(
            rule.next_after(utc("2026-03-28T00:00:00Z")),
            Some(utc("2026-03-28T08:00:00Z"))
        );
        // CEST (UTC+2) after it — still 09:00 in Paris.
        assert_eq!(
            rule.next_after(utc("2026-03-30T00:00:00Z")),
            Some(utc("2026-03-30T07:00:00Z"))
        );
    }

    // 02:30 does not exist on a spring-forward night; the run must still happen
    // that day rather than being silently skipped.
    #[test]
    fn daily_inside_the_spring_forward_gap_rolls_past_it() {
        let rule = daily("02:30", "Europe/Paris");
        let next = rule.next_after(utc("2026-03-29T00:00:00Z")).unwrap();
        assert_eq!(next, utc("2026-03-29T01:00:00Z"));
    }

    #[test]
    fn weekly_only_matches_selected_days() {
        let rule = Recurrence::parse(
            RecurrenceKind::Weekly,
            None,
            Some("09:00".into()),
            // Monday and Thursday.
            Some(vec![4, 1, 1]),
            None,
            Some("UTC".into()),
        )
        .unwrap();
        assert_eq!(rule.weekdays.as_deref(), Some(&[1, 4][..]));
        // 2026-07-24 is a Friday -> next match is Monday the 27th.
        assert_eq!(
            rule.next_after(utc("2026-07-24T12:00:00Z")),
            Some(utc("2026-07-27T09:00:00Z"))
        );
        // From Monday noon -> Thursday.
        assert_eq!(
            rule.next_after(utc("2026-07-27T12:00:00Z")),
            Some(utc("2026-07-30T09:00:00Z"))
        );
    }

    #[test]
    fn monthly_clamps_to_the_last_day_of_shorter_months() {
        let rule = Recurrence::parse(
            RecurrenceKind::Monthly,
            None,
            Some("09:00".into()),
            None,
            Some(31),
            Some("UTC".into()),
        )
        .unwrap();
        // February 2027 has 28 days, so "the 31st" fires on the 28th.
        assert_eq!(
            rule.next_after(utc("2027-02-01T00:00:00Z")),
            Some(utc("2027-02-28T09:00:00Z"))
        );
        assert_eq!(
            rule.next_after(utc("2027-03-01T00:00:00Z")),
            Some(utc("2027-03-31T09:00:00Z"))
        );
    }

    #[test]
    fn rules_reject_fields_that_do_not_match_their_kind() {
        assert!(Recurrence::parse(RecurrenceKind::Interval, None, None, None, None, None).is_err());
        assert!(
            Recurrence::parse(RecurrenceKind::Interval, Some(5), None, None, None, None).is_err()
        );
        assert!(Recurrence::parse(RecurrenceKind::Daily, None, None, None, None, None).is_err());
        assert!(Recurrence::parse(
            RecurrenceKind::Weekly,
            None,
            Some("09:00".into()),
            Some(vec![]),
            None,
            None
        )
        .is_err());
        assert!(Recurrence::parse(
            RecurrenceKind::Weekly,
            None,
            Some("09:00".into()),
            Some(vec![9]),
            None,
            None
        )
        .is_err());
        assert!(Recurrence::parse(
            RecurrenceKind::Monthly,
            None,
            Some("09:00".into()),
            None,
            Some(0),
            None
        )
        .is_err());
        assert!(Recurrence::parse(
            RecurrenceKind::Daily,
            None,
            Some("25:00".into()),
            None,
            None,
            None
        )
        .is_err());
        assert!(Recurrence::parse(
            RecurrenceKind::Daily,
            None,
            Some("09:00".into()),
            None,
            None,
            Some("Mars/Olympus".into())
        )
        .is_err());
    }

    #[test]
    fn interval_rules_drop_wall_clock_fields() {
        let rule = Recurrence::parse(
            RecurrenceKind::Interval,
            Some(3600),
            Some("09:00".into()),
            Some(vec![1]),
            Some(3),
            None,
        )
        .unwrap();
        assert_eq!(rule.time_of_day, None);
        assert_eq!(rule.weekdays, None);
        assert_eq!(rule.day_of_month, None);
    }

    #[test]
    fn row_round_trip_preserves_the_rule() {
        let rule = Recurrence::parse(
            RecurrenceKind::Weekly,
            None,
            Some("7:05".into()),
            Some(vec![2, 5]),
            None,
            Some("America/New_York".into()),
        )
        .unwrap();
        assert_eq!(rule.time_of_day.as_deref(), Some("07:05"));

        let restored = Recurrence::from_row(
            rule.kind.as_str(),
            rule.interval_seconds,
            rule.time_of_day.clone(),
            rule.weekdays_csv(),
            rule.day_of_month,
            rule.timezone.clone(),
        )
        .unwrap();
        assert_eq!(restored, rule);
    }

    #[test]
    fn storage_timestamps_round_trip() {
        let instant = utc("2026-07-24T09:30:00Z");
        assert_eq!(to_storage(instant), "2026-07-24 09:30:00");
        assert_eq!(from_storage("2026-07-24 09:30:00"), Some(instant));
        assert_eq!(from_storage("nonsense"), None);
    }
}
