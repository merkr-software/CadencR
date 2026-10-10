# Local provider scaffold QA — 2026-09-16

## Scope and boundary

- Cadencr commit: `0f13ac748`, branch `feature/define-provider-boundary-spec-de8e`.
- macOS development renderer driven through real DOM interactions, with the
  compiled service, an explicitly isolated temporary database and settings folder.
- Created `scaffold-qa` through **Add provider → Create new**. Created a second
  scaffold through the same backend API to exercise a non-resumable variant.
- Implemented a small Node.js connector inside the generated repository, using
  the actual generated `INSTRUCTION.md`, then built its stable `bin/provider`.
  Its separate native CLI is a **deterministic QA engine, not a real AI model**.
  No parent-application code was modified to register or run it.
- This establishes host-side scaffold/build/use/rebuild and mixed-capability
  behavior. It is not certification of a complete third-party/native AI provider,
  nor packaged-app QA or an agent-autonomous connector implementation trial.

## Results

| Case                              | Observed result                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate                          | UI navigated to project `1`, feature `1`; Git repository, instructions and descriptor existed; executable did not initially exist.                                                                                               |
| Implement/build                   | Added source, native CLI, parser tests, build script and icon. Build created executable `bin/provider`; binaries stayed ignored by Git.                                                                                          |
| Local contract                    | `version` and `models --format acp-config-options-v1 --cwd ...` succeeded. Six connector tests passed: model mapping, malformed JSON, empty models, duplicate IDs, blank ID and ACP initialization.                              |
| Restart gate                      | Catalog omitted newly registered providers before restart; after restart both variants were `available` with `qa/deterministic`.                                                                                                 |
| Use through UI                    | Selected the generated provider/model, sent `REMEMBER SCAFFOLD_0916`, received `QA_ACK:REMEMBER SCAFFOLD_0916`; runtime negotiated the live model before prompting.                                                              |
| Resume                            | After service restart, UI transcript remained present. `RECALL` produced `QA_RECALL:REMEMBER SCAFFOLD_0916`; connector trace recorded `session/resume` with its original opaque ID.                                              |
| Non-resumable alongside resumable | Separate volatile conversation produced an ACK before restart. Its transcript survived, but `RECALL` after restart returned empty native context. Trace showed a fresh `session/new` and a different ID, never `session/resume`. |
| Rebuild                           | Edited connector behavior and version, rebuilt to `0.1.1`, restarted service, sent `BUILD_V2_OK`; UI displayed `QA_ACK_V2:BUILD_V2_OK` in the same resumable conversation.                                                       |
| Identity/retry                    | Both projects retained `authoring_target=provider` and their `plugin_id` after restart. Repeating scaffold creation returned project `1` / feature `1`, without adding projects or replacing implementation files.               |

## Trace evidence

- Resumable native session: `1a0cb9aa-01bf-4412-ab92-359e49f6b9e0` before and after
  restart, with `session/new` initially and `session/resume` subsequently.
- Volatile native sessions: `eadf723c-ee4b-44ec-b6b9-03f9160f7cf5`, then
  `02f8ae70-0a90-4899-9c9f-2d267f70e551`; no resume attempt.
- Resumable QA used feature `1`; volatile QA used feature `3` in project `2`.
  Feature `2` was excluded: an initial UI automation action raced navigation and
  submitted the marker prompt to the default Claude provider. That test session
  was interrupted, then the volatile case was repeated in a fresh conversation
  with explicit verification of the selected provider/model before sending.
- Browser console included the expected desktop-shell configuration warning and
  connection-refused/reconnect messages during deliberate service restarts.
  The excluded Claude attempt also logged provider-specific event warnings; these
  are not evidence about the generated connector.

## Remaining release gates

- Packaged theme edit/live-apply, rename, failure/retry and cleanup lifecycle.
- Supported packaged targets, native folder-picker interaction and final release
  integration checks. This run does not close all of L4 or L5.
- No marketplace, registry publication, merge, push or release was performed.

## Cleanup

QA-opened browser tab and task-owned service/renderer were stopped. Ports `1424`
and `5103` were verified free and no fixture connector process remained. Temporary
QA databases and fixtures were retained; existing user/dev databases were not used.
