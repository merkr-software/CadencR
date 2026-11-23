---
name: perf
description: >
  Investigate and fix a Cadencr performance problem (freeze, stall, lag, slow query, high CPU, memory growth,
  disconnects under load, subprocess storms, janky UI) on any layer: Rust service, SQLite, WebSocket/streaming,
  git/subprocesses, Electron main, or React renderer. Use it whenever the user reports something slow or
  frozen, asks to "optimize", "speed up", "reduce latency", "profile", or "find bottlenecks", and before
  writing any commit whose type is `perf`. It enforces measure → hypothesize → fix one thing → re-measure →
  behavior QA.
argument-hint: [symptom or area]
user-invocable: true
---

# Performance Work

Symptom or area: $ARGUMENTS

A performance change is a behavior change on a hot path. It ships only with a measured cause, a measured
gain, and proof that what the user sees still behaves the same. A plausible fix built on an unmeasured
hypothesis is how the 2026-11 "anti-freeze" series shipped a ×6–30 query regression (a correlated subquery
relying on an index dropped months earlier), silently dropped terminal pastes, delayed the Stop button by
15 s, froze PR statuses, and capped `git blame` at 30 s, all with green tests.

Work in the phases below, in order. Each phase ends with something written down: the next one starts from
it, not from intuition.

## Phase 1 — Frame the symptom

Write down, before reading code:

- **What the user experiences**: the action, what they see (freeze, spinner, "Disconnected" toast,
  dropped input), and how often.
- **The metric that captures it**: request latency, event-loop stall, frame time / long animation frames,
  WS backlog, process count, memory, CPU. Name the number you will compare before and after.
- **The data scale it needs**: projects, features, sessions, messages, repo size, diff size, number of
  concurrent agents or terminals. Most Cadencr stalls only appear on a heavy user's data.
- **Platforms**: macOS and Linux behave differently for file watching, process tables, fsync and
  filesystem case sensitivity. Note which one the report came from.

## Phase 2 — Reproduce and measure the baseline on the unchanged code

No fix is designed before the symptom is reproduced and measured on the code you start from.

1. Start an isolated run with the `qa` skill (`pnpm qa:up`). Never measure on `~/.cadencr/database` and never
   start a service on a copy of a database that holds real schedules or agents.
2. Load realistic data into the run's database (`<run>/app/db/qa.db`):
   - Synthetic heavy user: `sqlite3 "<run>/app/db/qa.db" < .agents/skills/perf/seed-large.sql` (scale knobs
     at the top; ~400k messages in a few seconds).
   - Real shapes, read-only: from the run's database, `ATTACH 'file:<prod db path>?mode=ro' AS prod`
     and `INSERT … SELECT` features, sessions (forced to `completed`, with `runtime_session_id`,
     `subprocess_id`, pending gates and drafts cleared) and their messages. Never copy schedules.
   - Repo-scale cases (huge diffs, many untracked files, large blame) go in the run's scratch project.
3. Use a build representative of the shipped app: release service binary for CPU-bound backend work;
   production renderer build for UI timings (dev React and StrictMode inflate numbers ~3×).
4. Measure with the tool that matches the layer (see "Measurement toolbox"), at least 5 runs, and record the
   median and the worst. Note the machine load (`uptime`): load averages above ~10 skew results, so compare
   only numbers taken in the same session.
5. Capture **evidence of the cause**, not just of the symptom: a stack sample of the stalled thread, a
   query plan, a CPU profile, a count of spawned processes. "This code looks slow" is not evidence.

If you cannot reproduce it, stop and report what you tried. Do not fix a symptom you could not observe.

## Phase 3 — Hypotheses with evidence, then pick a scope

Write a short table: hypothesis, evidence (measurement + file:line), expected gain, confidence, risk.
Present it to the user and agree on what to fix before writing code. Rank by measured share of the
symptom, not by how many issues were found.

Before prescribing a design (to yourself or to a subagent), **verify its premises in the code**:

- **SQL**: the index you rely on exists *after* `run_migrations` (search `migrations/` for its creation
  and any later `DROP INDEX`, and `shared/migrate/seed.rs` for repairs). Do not trust comments that name
  an index.
- **Platform semantics**: case-insensitive APFS refs, inotify overflow events without paths, FSEvents path
  canonicalization (`/private/var`), `fullfsync` defaults, process-group signals.
- **Ordering and durability contracts**: who reads the DB while you buffer writes, what a reconnecting
  client fetches, what rewind/fork delete, what a Stop expects to be already registered.
- **Every caller** of a function whose latency, error type or blocking behavior you change.

Scope rule: **one topic per branch and per commit.** A subject is one mechanism (a query, a cache, a lane,
a writer). Fixing five subsystems at once multiplies the review and QA cost and hides regressions. When the
user asks for "everything", propose a sequence of small branches instead and say why.

## Phase 4 — Implement with behavior tests and guardrails

Tests must fail without the fix (run them on the unchanged code, or reintroduce the bug once) and must
describe behavior, not implementation:

- **SQL**: assert plans on the real migrated schema with `shared::test_query_plan` (`migrated_pool`,
  `assert_no_full_scan`, `forge_index_stats` to simulate another planner). Never only "no `SCAN m`": a
  correlated subquery without an index prints as a bare `SEARCH <alias>`.
- **Timers and coalescing**: `#[tokio::test(start_paused = true)]` with `tokio::time::advance`, never
  real-clock windows.
- **The user-visible contract** the optimization could break: "a paste larger than the queue arrives
  whole or the user is told", "Stop is offered as soon as the prompt is sent", "a late viewer sees no gap".

Checklist for the usual perf mechanisms (each one broke at least once in the 2026-11 series):

| Mechanism | Check |
| --- | --- |
| Cache | Invalidation on every write path and external edit; never cache errors; a fallback when the invalidation signal is lost (watcher overflow, dir replaced); bounded size. |
| Singleflight / dedup | Leader cancellation and panic release followers; key includes everything that changes the result (host, credentials, cwd). |
| Negative cache / backoff | Only for persistent failures (timeout, tool missing), never transient ones; the UI does not flicker or toast for the whole window. |
| Timeout | Per call: a slow `blame`/`status` is not a hung process; kill the process group, not just the leader; a killed watcher read must not loop. |
| Bounded queue / backpressure | Never drop input silently; control messages (kill, resize, stop) are never stuck behind data; memory stays bounded. |
| Lock release / reordering | List what the lock protected and what can now run in the window; state the user sees (running, Stop) is published before slow work. |
| Write buffering / coalescing | Readers of the DB (reconnect, history fetch, rewind, fork) see a consistent state; durability loss on crash is documented. |
| Moving work off Tokio workers | `spawn_blocking` keeps lock guards inside the closure; `JoinError` is propagated, not logged. |
| Gating / skipping work | Every event that should resume the work bumps the gate (token deleted, feature created). |

Follow the repo rules as usual: no swallowed errors, files ≤ 400 production lines (split modules, never
delete useful comments to fit), `pnpm rust -- …`, no session docs in tracked files.

## Phase 5 — Re-measure with the same protocol

Same data, same build type, same machine, same session. Report a before/after table with median and worst.
Also measure the paths next to the one you changed (sibling queries on the same table, other lists using
the same SQL fragment, the other platform's code path when reachable). A gain on one endpoint with a
regression on its neighbor is not a gain.

## Phase 6 — Behavior QA

Run the `qa` skill on a scenario matrix built from the checklist above: for each behavior the change can
affect, one real interaction in the real Electron app (`electron` surface; the headless renderer is for
timing benches only), driven like a user (UI over CDP, real agent turns with a small model, real terminal
input), on the heavy data. Typical scenarios: large paste into a busy terminal, prompt then immediate Stop
on an idle session, reconnect or open a conversation mid-stream, rewind during a stream, delete a forge
token, slow git repository. If `finish-job` or a review changes the code afterwards, rerun the affected
scenarios before committing.

## Phase 7 — Report and commit

- Commit messages and the final report claim only what was measured. Separate three classes explicitly:
  **measured before/after**, **measured after only** (say on which data), **not tested** (list the risky
  paths you did not exercise and the platform not validated).
- Every "verified" names the command or scenario and its result. Never write a result before reading the
  tool output.
- One topic per commit. Before rewriting history (fixup, rebase), check it is not merged already:
  `git merge-base --is-ancestor HEAD main` succeeding means add a new commit instead. Say "ready to merge"
  once, after every check has finished.

## Delegating to subagents

Parallel subagents are fine for measuring independent areas or implementing independent, already-verified
fixes. The parent still: verifies the premises of any design it prescribes (Phase 3), gives each subagent
one topic with the behavior contract to preserve and the scenario to QA, requires measurements and failing
tests in their report, and reads the diff of risky areas itself (streaming order and durability, turn and
Stop control, PTY bytes, destructive git, auth caches). A subagent's "all green" is not a review.

## Measurement toolbox

**Rust service (stalls, CPU, blocked workers)**
- macOS: `sample <service-pid> 5 -file <out>.txt` during the stall (shows Tokio workers parked in sync
  I/O, locks or SQLite); `spindump <pid>` for a whole-system view.
- Linux: `perf record -g -p <pid>` / `perf top -p <pid>`; `cat /proc/<pid>/task/*/stat` for stuck threads.
- Latency from outside: time the real API with `curl -s -o /dev/null -w '%{time_total}\n'` using the run's
  port and `X-Cadencr-Token` (not `Authorization`), repeated, median and worst.
- A blocked runtime shows as *every* endpoint slowing at once; a contended pool as only DB endpoints.

**SQLite**
- `EXPLAIN QUERY PLAN` on the seeded run database for the exact SQL the service sends; `.timer on` in
  `sqlite3`. The service embeds the SQLite of `libsqlite3-sys`, which may plan differently from the system
  `sqlite3`: confirm through the API or a Rust test.
- Pools: one writer connection (`write_pool`), a read pool; a long read or write is a stall for everyone
  queued behind it.

**WebSocket and streaming**
- Backlog = highest `payload.seq` of `session.message` frames seen over CDP
  (`Network.webSocketFrameReceived`) minus the store's `streamingState.lastMessageSeq` for that session.
  Measure it visible and hidden: an occluded dev Electron window is `document.hidden`, and rAF stops.

**Subprocess storms (git, gh, lsof, formatters, CLIs)**
- Sample `ps -Ao pid,ppid,etime,command | grep -c <tool>` over time, or put a logging shim first in `PATH`
  for the run. Measure spawns per minute before and after.

**Renderer and Electron**
- Chrome DevTools performance trace over the run's CDP port on a production renderer build;
  `long-animation-frame` and `event` PerformanceObservers; React Profiler for re-render counts during
  streaming (see `.claude/rules/frontend-performance.md`).
- Sample timings after paint (a `MessageChannel` message posted from `requestAnimationFrame`), not inside
  the rAF callback.

## Anti-patterns

- Optimizing from code reading alone, or reporting a cause no tool showed.
- Measuring only after the fix, or on an empty QA database (sub-millisecond numbers prove nothing).
- A test that confirms the hypothesis instead of trying to refute it.
- Several subsystems in one commit or branch; a subagent per subsystem with nobody reading the diffs.
- Silently changing a contract (ordering, durability, error codes, what is retried) for speed.
- Deleting doc comments to stay under the file-size limit.
- Calling the work "verified end to end" without the scenarios that exercise the changed behavior.
