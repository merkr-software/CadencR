---
name: qa
description: >
  QA test a running feature in the Cadencr app using browser automation. Use this skill whenever the user asks
  to "test", "QA", "smoke test", "check if it works", "verify the feature", "try it in the browser", or
  wants to validate that something they just built actually works in the real app. Also trigger when the user
  says "run QA", "does it look right", or "let me see it working". If a feature was just implemented and the
  user wants confirmation it works end-to-end, this is the skill to use.
user-invocable: true
allowed-tools: Bash(*), mcp__chrome-devtools__*
---

# QA Testing

Test Cadencr features in an **isolated run** started by `pnpm qa:up`, drive it over CDP, report with the
run's evidence summary, then stop it with `pnpm qa:down`.

The argument (`$ARGUMENTS`) describes the feature to test. If empty, infer it from the session context
(recent file changes, active branch, conversation history).

## What a run gives you

Each run has its own id and directory, so several QAs can run on the same machine at once, from the same
checkout or different ones:

- a fresh database, settings dir and data root (`--data-dir`: worktrees, marketplace LSP servers, forge and
  remote credentials, caches) under `<run>/app/`, never `cadencr.local.db`, a `.fresh-clone` or a copy of a
  database holding real schedules;
- free ports for the service, renderer and CDP, a random API token, a browser/Electron profile in the run;
- a scratch Git project already registered (`<run>/project`), onboarding and telemetry decision done;
- the **real `HOME`**: the Claude and Codex CLIs stay logged in, so agent turns work;
- `state.json` (PIDs with start times, ports, URLs, token, paths) and `evidence.md` to complete.

`qa:down` stops exactly the processes the run started (PID and start time re-checked, their descendants
included) and removes exactly its directories. A worktree the app created for a project outside the run is
unregistered from that repository with `git worktree remove`; its branch is left for you to delete.

## Step 1: Build (no time limit)

`pnpm qa …` reruns itself on the `.nvmrc` Node when the current one is outside `engines.node` (as the
pre-commit hook does), so Electron and Vite get the right one. Runs go under `CADENCR_QA_ROOT` (default
`$TMPDIR/cadencr-qa`); point it at your scratchpad. Agent shells do not keep variables between tool calls,
so set it in **every** command that names a run by id (`CADENCR_QA_ROOT="…" pnpm -s qa cdp <id> …`), or pass
the run's absolute directory instead of its id.

```bash
pnpm qa:build                    # doctor subset, dev .env files, Electron binary, lsof, Rust build
```

Run it in the **foreground**. A cold Rust build can take many minutes and the script never abandons it; if
your tool call times out first, rerun the same command: Cargo resumes. Add `--marketplace` only to test
marketplace installs (themes, tabs, LSP servers): it builds a service with the repository's public catalog
pins into `target/qa-marketplace`.

## Step 2: Start the run

```bash
CADENCR_QA_ROOT="<scratchpad>/qa-runs" pnpm qa:up --skip-build [--surface electron|renderer|service] [--marketplace] [--headed]
eval "$(pnpm -s qa env "<run-dir>")" # QA_RUN_DIR, QA_SERVICE_URL, QA_TOKEN, QA_CDP_PORT, QA_PROJECT_ID…
```

| Surface              | What runs                                                        | Use for                                                                                 |
| -------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `electron` (default) | service + real dev Electron app, CDP on its own port             | anything desktop-only: IPC, in-app browser, browser MCP, notch, menus, window behaviour |
| `renderer`           | service + Vite renderer + headless Chrome (`--headed` to see it) | pure UI flows when no Electron window should appear                                     |
| `service`            | service only                                                     | API and WebSocket behaviour                                                             |

`qa:up` returns only after the service answers with the run's token, refuses a request without it, and is
the process listening on its port, and (UI surfaces) after the renderer page is up on this run's CDP port and
the app has mounted. On failure it stops what it started and keeps `logs/` for inspection.

## Step 3: Plan

Before touching the UI, list 3-5 concrete cases (happy path and key edge cases), each with steps and the
expected outcome. Tell the user briefly what you are about to test.

## Step 4: Drive the app

Use the run's CDP helper. It talks to this run only, so it works with parallel runs; every command brings
the window to front and enables focus emulation (a hidden window otherwise breaks Radix popovers):

```bash
pnpm -s qa cdp "<run>" eval "<js expression; promises are awaited, the value is printed as JSON>"
pnpm -s qa cdp "<run>" click 'button[aria-label="Send message"]'   # CSS selector, or text=<exact visible text>
pnpm -s qa cdp "<run>" type "some text"                            # into the focused element
pnpm -s qa cdp "<run>" key Enter
pnpm -s qa cdp "<run>" screenshot <name>                           # -> <run>/screenshots/<name>.png
pnpm -s qa cdp "<run>" targets
```

- `click` is a real mouse event; Radix triggers ignore synthetic `el.click()`.
- Each command fails (instead of hanging) when the page reloads or the app exits, and after 180 s.
- Quote run paths: a scratchpad or `$TMPDIR` may contain spaces. The commands `qa` prints are already quoted.
- Wait for state before asserting: `eval` a promise that polls the DOM (with a deadline) instead of sleeping.
- Hash routing: `eval "location.hash = '#/projects/$QA_PROJECT_ID/features/<id>'"`.
- API calls: `curl -H "X-Cadencr-Token: $QA_TOKEN" "$QA_SERVICE_URL/api/…"`. A feature for an agent turn:
  `POST /api/features {"project_id": $QA_PROJECT_ID, "title": "…", "worktree_mode": "new"}`; its worktree
  lands under `<run>/app/data/worktrees`.
- Controlled React inputs: `type` goes through the browser's input pipeline. With `eval`, use the native value
  setter then dispatch `input` (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`).
- Under Vite dev, importing an app module from `eval` needs the exact URL the app loaded (HMR adds `?t=`);
  a plain `/src/...` import is a second, empty module instance.
- The chrome-devtools MCP drives one shared browser profile: use it only when a single QA runs, and only for
  the `renderer` surface (open `$QA_RENDERER_URL`).

**Agent turns use a small model.** In the composer open the model picker
(`click 'text=Default (recommended)'`) and pick Haiku (`click 'text=Haiku 5.5'`) before sending. Keep prompts
trivial ("Reply with exactly the word: pong").

After the cases, check the console (`eval` reading what the app logged, or `logs/desktop.log`) and
`logs/service.log`.

## Step 5: Report

Complete `<run>/evidence.md` (tested SHA, surface, scenarios, screenshots, limits, platforms not validated;
`qa:up` pre-fills what it knows) and put its content in your reply or the PR description. Embed each screenshot
with a one-line caption and its absolute path: `![caption](<run>/screenshots/<name>.png)`. If checks ran
somewhere else than the run's surface (for example an HTML bench rendering components alone), say so in the
Surface line: it changes what the result proves.

Never write the report, screenshots or helper scripts to a tracked file (rule `no-session-docs`).

## Step 6: Stop the run, even on failure

```bash
pnpm qa:down "<run>"          # stops its processes, removes app/, bin/, browser-profile/, project/
pnpm qa:down "<run>" --purge  # also removes evidence, screenshots and logs, once the user has seen them
pnpm -s qa list               # every run under CADENCR_QA_ROOT and whether its processes are alive
```

`qa:down` names any process still mentioning the run and any of its ports listening again. Never stop
processes that are not in the run's `state.json`: other Cadencr sessions, Electron apps and containers run on
this machine.

## Limits to state in the report

- The real `HOME` is shared: agent CLIs read `~/.claude` and `~/.codex`. Do not edit them, copy credentials,
  or install marketplace skills or MCP servers (they go through the CLIs into the real config) without the
  user's go-ahead.
- Two Electron runs from one checkout share `packages/desktop/out` (identical builds; their starts are
  serialized) and macOS keeps one preferences file for the dev Electron binary.
- A run on macOS proves nothing about Linux, and the reverse: list the other platform as not validated.
