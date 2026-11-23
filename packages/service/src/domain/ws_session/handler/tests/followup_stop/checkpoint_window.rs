//! The window between a prompt's persistence and its hand-over, where it
//! waits for its pre-turn checkpoint under the session's follow-up order lock.
//! Holding that lock stands in for a slow checkpoint.

use std::time::Duration;

use super::*;

const SECOND: &str = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

impl Fixture {
    /// Hold the order lock, as a slow checkpoint does.
    async fn hold_checkpoint(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.app_state
            .active_turns
            .lock_followup_delivery(self.db_id)
            .await
    }

    async fn wait_busy(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !self.app_state.session_status_tx.is_busy(self.db_id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the session reads as working");
    }

    /// Wait until `count` prompts (and the test) hold or wait for the order
    /// lock: each reserved its turn or follows one by then.
    async fn wait_queued(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            let turns = &self.app_state.active_turns;
            while turns.followup_delivery_holders(self.db_id).await < count + 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the prompts queue for the checkpoint");
    }

    fn runtime(&self) -> RuntimeSessionHandle {
        self.sessions.try_lock().unwrap()[&self.db_id]
            .state
            .active_query()
            .expect("the fixture owns a live runtime")
    }

    /// Whether a Stop left its mark on the runtime's current turn.
    async fn interruption_marked(&self) -> bool {
        let runtime = Arc::downgrade(&self.runtime());
        self.app_state
            .active_turns
            .take_interruption(self.db_id, &runtime)
            .await
            .is_some()
    }
}

/// Found in review: a prompt sent while idle marked the session working only
/// after its checkpoint, so no client saw Stop meanwhile, and a Stop found
/// nothing to stop. It now reserves its turn first; a Stop cancels it, ends
/// the turn at once and never interrupts the idle runtime.
#[tokio::test]
async fn a_stop_during_an_idle_prompts_checkpoint_withdraws_it() {
    let mut fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;
    fixture.wait_busy().await;
    assert_eq!(
        db_status(&fixture.app_state, fixture.db_id).await,
        "running"
    );

    tokio::time::timeout(
        Duration::from_secs(2),
        stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id),
    )
    .await
    .expect("the Stop does not wait for the checkpoint")
    .unwrap();
    assert!(!fixture.app_state.session_status_tx.is_busy(fixture.db_id));
    assert_ne!(
        db_status(&fixture.app_state, fixture.db_id).await,
        "running"
    );
    assert!(
        !fixture.interruption_marked().await,
        "the idle runtime was not interrupted"
    );

    drop(checkpoint);
    dispatch.await.unwrap();
    wait_for_failed(&fixture).await;
    assert!(
        fixture.streamed.try_recv().is_err(),
        "the runtime never got it"
    );
    assert_eq!(fixture.dispatch_status().await, "error");
    assert!(!fixture.app_state.session_status_tx.is_busy(fixture.db_id));
}

/// The perf fix the window exists for: a Stop is not held behind the
/// checkpoint of a follow-up sent mid-turn, and cancels it.
#[tokio::test]
async fn a_stop_during_a_follow_ups_checkpoint_cancels_it_without_waiting() {
    let mut fixture = fixture(true).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;

    tokio::time::timeout(
        Duration::from_secs(2),
        stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id),
    )
    .await
    .expect("the Stop does not wait for the checkpoint")
    .unwrap();
    assert!(
        fixture.interruption_marked().await,
        "the running turn is stopped"
    );

    drop(checkpoint);
    dispatch.await.unwrap();
    wait_for_failed(&fixture).await;
    assert!(fixture.streamed.try_recv().is_err());
}

/// Prompts waiting for the checkpoint reach the runtime in the order sent.
#[tokio::test]
async fn prompts_behind_a_checkpoint_keep_their_order() {
    let mut fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let first = fixture.dispatch_prompt(FOLLOW_UP, "first", true);
    fixture.wait_queued(1).await;
    let second = fixture.dispatch_prompt(SECOND, "second", true);
    fixture.wait_queued(2).await;

    drop(checkpoint);
    first.await.unwrap();
    second.await.unwrap();
    let mut texts = Vec::new();
    for _ in 0..2 {
        let content = tokio::time::timeout(Duration::from_secs(2), fixture.streamed.recv())
            .await
            .expect("both prompts reach the runtime")
            .unwrap();
        texts.push(content.to_string());
    }
    assert!(texts[0].contains("first"), "{texts:?}");
    assert!(texts[1].contains("second"), "{texts:?}");
}

/// Found in review: two clients prompting an idle session at once both read
/// it idle, so the second was no follow-up a Stop cancels. Now one reserves
/// the turn and the other follows it: one Stop withdraws both.
#[tokio::test]
async fn two_idle_prompts_at_once_start_one_turn_that_a_stop_cancels() {
    let mut fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let first = fixture.dispatch_prompt(FOLLOW_UP, "from the desktop", true);
    let second = fixture.dispatch_prompt(SECOND, "from the phone", true);
    fixture.wait_queued(2).await;

    stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
        .await
        .unwrap();
    assert!(!fixture.interruption_marked().await);
    drop(checkpoint);
    first.await.unwrap();
    second.await.unwrap();

    fixture.wait_failed_of(FOLLOW_UP).await;
    fixture.wait_failed_of(SECOND).await;
    assert!(fixture.streamed.try_recv().is_err(), "neither reached it");
    assert!(!fixture.app_state.session_status_tx.is_busy(fixture.db_id));
}

/// Found in review: a rewind (or fork, or close) that replaced the runtime
/// while a prompt waited for its checkpoint let the prompt stream to the
/// closed runtime. It is now withdrawn, and the turn it reserved ends.
#[tokio::test]
async fn a_rewind_during_the_checkpoint_withdraws_the_prompt() {
    let mut fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;
    fixture.wait_busy().await;

    let branching = super::super::super::session_branch::stop_live_turn(
        &fixture.sessions,
        &fixture.app_state,
        fixture.db_id,
    )
    .await;
    drop(branching);
    drop(checkpoint);
    dispatch.await.unwrap();

    wait_for_failed(&fixture).await;
    assert!(
        fixture.streamed.try_recv().is_err(),
        "the closed runtime got nothing"
    );
    assert_eq!(fixture.dispatch_status().await, "error");
    assert!(!fixture.app_state.session_status_tx.is_busy(fixture.db_id));
    assert!(matches!(
        fixture.sessions.lock().await[&fixture.db_id].state,
        QueryState::Pending(_)
    ));
}

/// The same for a follow-up sent mid-turn: before the fix it streamed to the
/// runtime the rewind had just closed.
#[tokio::test]
async fn a_rewind_during_a_follow_ups_checkpoint_withdraws_it() {
    let mut fixture = fixture(true).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;

    let branching = super::super::super::session_branch::stop_live_turn(
        &fixture.sessions,
        &fixture.app_state,
        fixture.db_id,
    )
    .await;
    drop(branching);
    drop(checkpoint);
    dispatch.await.unwrap();

    wait_for_failed(&fixture).await;
    assert!(
        fixture.streamed.try_recv().is_err(),
        "the closed runtime got nothing"
    );
    assert_eq!(fixture.dispatch_status().await, "error");
}

/// Found in review: a reservation a follow-up overtook (it handed over first
/// and started a turn) no longer means that nothing runs. The Stop must
/// interrupt the running turn instead of only cancelling the reservation.
#[tokio::test]
async fn a_stop_interrupts_a_turn_that_overtook_a_reservation() {
    let mut fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;
    fixture.wait_queued(1).await;
    // Another prompt's turn begins, as a follow-up handed over first would.
    fixture
        .app_state
        .active_turns
        .begin_turn(fixture.db_id, &fixture.sessions)
        .await;

    stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
        .await
        .unwrap();
    assert!(
        fixture.interruption_marked().await,
        "the running turn is stopped"
    );

    drop(checkpoint);
    dispatch.await.unwrap();
    wait_for_failed(&fixture).await;
    assert!(fixture.streamed.try_recv().is_err());
}

/// Found in review: a reserved start that hands over after another turn
/// began and ended must mark the session working again for its own turn.
#[tokio::test]
async fn a_reservation_overtaken_by_an_ended_turn_marks_its_own_turn() {
    let mut fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;
    fixture.wait_queued(1).await;
    let turns = &fixture.app_state.active_turns;
    turns.begin_turn(fixture.db_id, &fixture.sessions).await;
    fixture.app_state.session_status_tx.broadcast(
        fixture.db_id,
        1,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );

    drop(checkpoint);
    dispatch.await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the prompt reaches the runtime");
    assert!(fixture.app_state.session_status_tx.is_busy(fixture.db_id));
    assert_eq!(
        db_status(&fixture.app_state, fixture.db_id).await,
        "running"
    );
}

/// Found in review: a prompt cancelled during its checkpoint (its socket
/// closed, its remote device was revoked) left the turn it reserved working
/// forever.
#[tokio::test]
async fn a_prompt_cancelled_during_its_checkpoint_ends_its_turn_idle() {
    let fixture = fixture(false).await;
    let checkpoint = fixture.hold_checkpoint().await;
    let dispatch = fixture.send_held_follow_up().await;
    fixture.wait_queued(1).await;
    fixture.wait_busy().await;

    dispatch.abort();
    assert!(dispatch.await.unwrap_err().is_cancelled());
    drop(checkpoint);

    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture.app_state.session_status_tx.is_busy(fixture.db_id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the reserved turn ends idle");
    assert_ne!(
        db_status(&fixture.app_state, fixture.db_id).await,
        "running"
    );
}
