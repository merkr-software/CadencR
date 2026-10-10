# Local provider QA — 2026-09-13

## Scope and evidence

Initial QA used Cadencr `bc8519bf1` with the existing external Pi connector `0.4.0`,
native Pi `0.84.1`, and `openai-codex/gpt-5.6-luna`.
The connector was copied into a temporary QA directory; its repository was not
modified. This proves local registration/use, not the generated-provider
scaffold path, theme authoring, marketplace delivery, or packaged-app readiness.

Local evidence is retained at `/tmp/cadencr-pi-qa.1EzFG2/`: `REPORT.md`,
`service.log`, `service-restart.log`, and `ui-after-resume.txt`. These files are
machine-local artifacts, not portable CI evidence.

## Verified scenarios

| Scenario                                                          | Result                                  |
| ----------------------------------------------------------------- | --------------------------------------- |
| Native ACP discovery, initialization, configuration and close     | Passed                                  |
| Native streaming, tools, permission bridge and usage              | Passed                                  |
| Native connector restart and durable context recall               | Passed                                  |
| Pi selection and conversation in the Cadencr browser renderer     | Passed                                  |
| Allow once for a harmless Bash `printf`                           | Passed                                  |
| Deny a Bash request                                               | Passed; agent acknowledged denial       |
| Cancel while a permission request is pending                      | Passed; session returned idle           |
| Restart Cadencr service, reload UI, recall first-message codeword | Passed; same durable runtime session ID |
| Stop QA servers and close the QA browser tab                      | Passed; ports `5103` and `1424` closed  |

## Follow-up from this run

- Fixed frontend warning source: operational `Init`/`Other` events no longer enter
  the transcript envelope; runtime ID, MCP and usage handling remain upstream.
- Fixed ACP shutdown: release the session-owned sender so readers reach EOF while
  the runtime remains alive; bound courtesy close below the host shutdown deadline.
- Repeated the real Pi context-recall turn on the corrected working tree after these fixes. No unknown-message
  warning occurred. A service-only SIGTERM produced `SDK stream closed` and
  `Active -> Pending` within approximately 8 ms, with no reader-abort warning.
  Evidence: `service-final.log` in the same local QA directory.
- Added regressions for operational-event filtering and sequence preservation,
  retained-session stream EOF, and a peer that does not answer `session/close`.
- Finish-job review consolidated the operational-event predicate and added a real
  subprocess regression with the initial prompt still in flight and an unanswered
  close request. Shutdown completed within the host deadline and the retained
  runtime stream reached EOF; no further sender-lifetime defect was reproduced.
- Dynamic MCP registration remains unsupported by this Pi connector.
- The temporary workspace had no Git repository: Git status/checkpoint failures
  in this run do not establish a provider regression.
- Initial model discovery failed inside the execution sandbox, but succeeded
  outside it without changing Pi credentials. Do not diagnose missing credentials
  from that first failure alone.

## Final merge checks

- Local `main` at `20e6556b2` and branch HEAD `bc8519bf1` merge-tree rehearsal:
  no conflicts. Final corrective files do not overlap the three main-only commits.
  This is a local-ref check, not proof against a subsequently updated remote.
- Pre-commit-equivalent pipeline before finish-job simplification: all 22 tasks
  successful (16 cached),
  covering formatting, lint, TypeScript, tests and knip; registry wrapper tests
  also passed. The changed service tests were executed, not reused from cache.
- After finish-job simplification, the complete service library suite was rerun:
  2,972 passed, 0 failed, 1 ignored. The real-spawn EOF regression drains final
  events rather than depending on the peer reading a notification before exit;
  the in-memory regression separately verifies the cancel wire sequence.
- Desktop tests independently rerun: 550 files, 4,299 tests passed.
- Added event-filtering and responsive/nonresponsive shutdown regressions pass.
- `git diff --check` passed. No merge, commit or push performed during this audit.
- This closes the two observed runtime warnings; L4 packaged/theme/scaffold
  verification remains a release gate, not a claim made by this provider QA.

## QA isolation incident

The initial standard `pnpm dev` launch used the existing development database,
not the temporary database requested through environment variables. Debug builds
load the package `.env` with `dotenvy::from_path_override`, overriding those
variables before configuration parsing.

The service automatically backed up and migrated `packages/service/cadencr.local.db`
before it was stopped. Its backup rotation also pruned one superseded backup.
The newly created backup was retained; no rollback was attempted. Startup logs
reported successful migrations, but no before/after data-integrity comparison
was performed. This was a QA isolation failure, not an isolated migration test.

All subsequent backend launches used explicit CLI arguments, whose precedence
was verified through the service log and the settings path shown in the UI:

```sh
./target/debug/cadencr-service \
  --db-path "$QA_ROOT/qa.db" \
  --settings-dir "$QA_ROOT/settings"
```

For future QA, use a fresh temporary directory and explicit CLI paths; do not
rely on environment-only overrides for debug database isolation. Keep every
QA database and backup. Do not start an existing database to test migrations.
