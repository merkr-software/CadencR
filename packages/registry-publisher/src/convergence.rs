//! Bounded convergence of an authenticated read that follows an accepted
//! write.
//!
//! GitHub's ref, commit, tree, contents and listing endpoints can briefly
//! serve the pre-write state after a write succeeded, so the read-back
//! converges within a deadline and an attempt budget instead of trusting one
//! read. One implementation serves every read-after-write in the publisher;
//! the clock and the sleep are injectable so tests never wait.
use std::time::{Duration, Instant};

use crate::PublisherError;

/// Total time one convergence may take before the stale state is final.
const BUDGET: Duration = Duration::from_secs(30);
/// First pause between reads; it doubles up to eight times this value.
const PAUSE: Duration = Duration::from_millis(250);
/// Reads at most. With the pauses above, thirty seconds fit about sixteen
/// back-to-back reads, so this cap is what ends a run of fast reads; slow
/// reads end at the deadline first.
const ATTEMPTS: u32 = 15;

/// The public CDN may serve a cached body for its whole `max-age`: raw
/// GitHub content answers `Cache-Control: max-age=300`, so a URL fetched in
/// the last five minutes keeps its previous body for up to ~300 s after the
/// write. The budget is that window plus margin.
const PUBLIC_BUDGET: Duration = Duration::from_secs(360);
/// First pause of a public read-back; it doubles up to eight times this value.
const PUBLIC_PAUSE: Duration = Duration::from_secs(1);
/// Reads at most. The pauses above fit 48 back-to-back reads in 360 s, so
/// this cap ends a run of fast reads (after ~335 s of waiting, still past the
/// 300 s `max-age`); slow reads end at the deadline first.
const PUBLIC_ATTEMPTS: u32 = 45;

/// Pacing of one convergence. The clock and the sleep are injectable.
#[derive(bon::Builder)]
pub(crate) struct ReadBack {
    pub(crate) budget: Duration,
    pub(crate) pause: Duration,
    pub(crate) attempts: u32,
    #[builder(with = |clock: impl Fn() -> Instant + 'static| Box::new(clock))]
    pub(crate) clock: Box<dyn Fn() -> Instant>,
    #[builder(with = |wait: impl Fn(Duration) + 'static| Box::new(wait))]
    pub(crate) wait: Box<dyn Fn(Duration)>,
}

impl ReadBack {
    /// The one production pacing: about thirty seconds, real time.
    pub(crate) fn production() -> Self {
        Self::builder()
            .budget(BUDGET)
            .pause(PAUSE)
            .attempts(ATTEMPTS)
            .clock(Instant::now)
            .wait(std::thread::sleep)
            .build()
    }

    /// The pacing of a read-back of the PUBLIC stable URL, which sits behind
    /// a CDN cache of up to five minutes: about six minutes, real time. The
    /// authenticated API read-back keeps `production()`.
    pub(crate) fn public_feed() -> Self {
        Self::builder()
            .budget(PUBLIC_BUDGET)
            .pause(PUBLIC_PAUSE)
            .attempts(PUBLIC_ATTEMPTS)
            .clock(Instant::now)
            .wait(std::thread::sleep)
            .build()
    }
}

/// What one read says about the awaited state.
pub(crate) enum Verdict<T> {
    /// The write is visible.
    Done(T),
    /// Exactly the state before the write: replication lag, keep waiting.
    Stale,
    /// Anything else: someone else changed it, stop at once.
    Foreign,
}

/// How a convergence ended.
pub(crate) enum Converged<T> {
    Done(T),
    /// Still pre-write after this many reads.
    Stale(u32),
    Foreign,
}

/// Read until `judge` sees the write, sees a foreign state, or sees only the
/// stale state for the whole budget. `read` receives the deadline every
/// request must respect; a `judge` error is terminal.
pub(crate) fn converge<R, T>(
    pacing: &ReadBack,
    read: impl Fn(Instant) -> Result<R, PublisherError>,
    judge: impl Fn(R) -> Result<Verdict<T>, PublisherError>,
) -> Result<Converged<T>, PublisherError> {
    let deadline = (pacing.clock)() + pacing.budget;
    let mut reads = 0;
    loop {
        let observed = match read(deadline) {
            Ok(observed) => observed,
            // A request cut off by the deadline after stale reads is the
            // stale outcome, not a transport fault.
            Err(_) if reads > 0 && (pacing.clock)() >= deadline => {
                return Ok(Converged::Stale(reads))
            }
            Err(error) => return Err(error),
        };
        reads += 1;
        match judge(observed)? {
            Verdict::Done(value) => return Ok(Converged::Done(value)),
            Verdict::Foreign => return Ok(Converged::Foreign),
            Verdict::Stale => {}
        }
        let pause = pacing.pause.saturating_mul(1 << (reads - 1).min(3));
        let remaining = deadline.saturating_duration_since((pacing.clock)());
        if reads >= pacing.attempts || remaining <= pause {
            return Ok(Converged::Stale(reads));
        }
        (pacing.wait)(pause);
    }
}

#[cfg(test)]
mod virtual_clock {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;

    /// The production pacing on a virtual clock: waiting only advances the
    /// clock, so thirty seconds pass without sleeping.
    pub(crate) struct VirtualClock {
        base: Instant,
        /// Every wait asked for, in order.
        pub(crate) waits: Rc<RefCell<Vec<Duration>>>,
    }

    impl VirtualClock {
        pub(crate) fn new() -> Self {
            Self {
                base: Instant::now(),
                waits: Rc::default(),
            }
        }

        pub(crate) fn read_back(&self) -> ReadBack {
            self.read_back_capped(ATTEMPTS)
        }

        pub(crate) fn read_back_capped(&self, attempts: u32) -> ReadBack {
            self.paced(BUDGET, PAUSE, attempts)
        }

        /// `ReadBack::public_feed()` on this clock.
        pub(crate) fn public_read_back(&self) -> ReadBack {
            self.public_read_back_capped(PUBLIC_ATTEMPTS)
        }

        pub(crate) fn public_read_back_capped(&self, attempts: u32) -> ReadBack {
            self.paced(PUBLIC_BUDGET, PUBLIC_PAUSE, attempts)
        }

        fn paced(&self, budget: Duration, pause: Duration, attempts: u32) -> ReadBack {
            let (base, elapsed, recorded) =
                (self.base, Rc::clone(&self.waits), Rc::clone(&self.waits));
            ReadBack::builder()
                .budget(budget)
                .pause(pause)
                .attempts(attempts)
                .clock(move || base + elapsed.borrow().iter().sum::<Duration>())
                .wait(move |pause| recorded.borrow_mut().push(pause))
                .build()
        }
    }
}
#[cfg(test)]
pub(crate) use virtual_clock::VirtualClock;

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn the_authenticated_pacing_is_thirty_seconds_and_the_public_one_outlasts_the_cdn_cache() {
        let (authenticated, public) = (ReadBack::production(), ReadBack::public_feed());
        assert_eq!(authenticated.budget, Duration::from_secs(30));
        assert_eq!(authenticated.attempts, 15);
        // raw.githubusercontent.com serves `max-age=300`.
        assert_eq!(public.budget, Duration::from_secs(360));
        assert_eq!(public.pause, Duration::from_secs(1));
        assert_eq!(public.attempts, 45);
    }

    #[test]
    fn the_public_attempt_cap_binds_before_the_deadline_yet_after_the_max_age() {
        let clock = VirtualClock::new();
        let outcome = converge(
            &clock.public_read_back(),
            |_| Ok(()),
            |()| Ok(Verdict::<()>::Stale),
        );
        assert!(matches!(outcome, Ok(Converged::Stale(45))));
        let waits = clock.waits.borrow();
        assert_eq!(waits.len(), 44);
        assert_eq!(
            waits[..5],
            [1, 2, 4, 8, 8].map(Duration::from_secs),
            "doubling up to eight seconds"
        );
        let waited: Duration = waits.iter().sum();
        assert!(waited > Duration::from_secs(300), "{waited:?}");
        assert!(waited < Duration::from_secs(360), "{waited:?}");
    }

    #[test]
    fn a_judge_error_is_terminal_and_a_deadline_cut_after_stale_reads_is_stale() {
        let clock = VirtualClock::new();
        let reads = Cell::new(0);
        let error = converge(
            &clock.read_back(),
            |_| Ok(reads.replace(reads.get() + 1)),
            |read| {
                if read == 1 {
                    Err(PublisherError::new("mismatch"))
                } else {
                    Ok(Verdict::<()>::Stale)
                }
            },
        )
        .err()
        .expect("judge error");
        assert_eq!(error.to_string(), "mismatch");
        assert_eq!(clock.waits.borrow().len(), 1);

        let clock = VirtualClock::new();
        let pacing = clock.read_back();
        let calls = Cell::new(0);
        let outcome = converge(
            &pacing,
            |deadline| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Ok(())
                } else {
                    // The request outlives the deadline.
                    (pacing.wait)(deadline.saturating_duration_since((pacing.clock)()));
                    Err(PublisherError::new("deadline exceeded"))
                }
            },
            |()| Ok(Verdict::<()>::Stale),
        );
        assert!(matches!(outcome, Ok(Converged::Stale(1))));
    }
}
