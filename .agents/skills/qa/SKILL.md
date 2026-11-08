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

Test Cadencr features by driving the app in Chrome via the `chrome-devtools` MCP server and verifying behavior interactively.

The argument (`$ARGUMENTS`) describes the feature to test. If empty, infer the feature from the current session context (recent file changes, active branch, conversation history).

## Step 1: Ensure Dev Servers Are Running

The Cadencr stack has two servers:
- **Frontend** (Vite): `http://127.0.0.1:$VITE_FRONTEND_PORT`
- **Backend** (Rust service): `http://127.0.0.1:$CADENCR_RUST_PORT/api/health`

Check if they're already up and healthy:

```bash
# Load local overrides from the package env files when present
set -a
[ -f packages/service/.env ] && . ./packages/service/.env
[ -f packages/desktop/.env ] && . ./packages/desktop/.env
set +a

FRONTEND_PORT="${VITE_FRONTEND_PORT:-1420}"
API_PORT="${CADENCR_RUST_PORT:-5005}"
FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"
API_HEALTH_URL="http://127.0.0.1:$API_PORT/api/health"

# Clear stale QA-run markers before checking server health
export CADENCR_QA_RUN_DIR="/tmp/cadencr-qa"
mkdir -p "$CADENCR_QA_RUN_DIR"
rm -f "$CADENCR_QA_RUN_DIR/dev.pid" "$CADENCR_QA_RUN_DIR/dev.pgid"

# Health-check both servers (2-second timeout each)
curl -sf --max-time 2 "$API_HEALTH_URL" && echo "API: ok" || echo "API: down"
curl -sf --max-time 2 "$FRONTEND_URL" && echo "Frontend: ok" || echo "Frontend: down"
```

**If both are healthy**, skip to Step 2.

**If either is down**, start the full stack in a tracked process group and write logs to disk so the agent can inspect them during QA:

```bash
# Start the full stack from the project root and capture logs for later inspection
sh -c 'repo_root=$(git rev-parse --show-toplevel) && cd "$repo_root" && exec pnpm dev' \
  >"$CADENCR_QA_RUN_DIR/dev.log" 2>&1 &
DEV_PID=$!
DEV_PGID=$(ps -o pgid= -p "$DEV_PID" | tr -d ' ')
printf '%s\n' "$DEV_PID" > "$CADENCR_QA_RUN_DIR/dev.pid"
printf '%s\n' "$DEV_PGID" > "$CADENCR_QA_RUN_DIR/dev.pgid"
echo "QA started dev stack: pid=$DEV_PID pgid=$DEV_PGID"
echo "QA dev log: $CADENCR_QA_RUN_DIR/dev.log"
```

Then poll until both servers respond (timeout after 60 seconds):

```bash
for i in $(seq 1 60); do
  api=$(curl -sf --max-time 1 "$API_HEALTH_URL" && echo "ok" || echo "")
  fe=$(curl -sf --max-time 1 "$FRONTEND_URL" > /dev/null 2>&1 && echo "ok" || echo "")
  [ "$api" = "ok" ] && [ "$fe" = "ok" ] && echo "Both servers ready" && break
  sleep 1
done
```

If servers don't come up within 60 seconds, report the failure and stop.

If startup fails, inspect the captured log before continuing:

```bash
tail -n 200 /tmp/cadencr-qa/dev.log
```

## Step 2: Plan Test Procedures

Before touching the browser, think about what to test. Based on the feature description:

1. Identify 3-5 concrete test cases covering the happy path and key edge cases
2. For each test case, note the steps (navigate, click, type, verify) and expected outcome
3. Briefly tell the user what you're about to test so they can course-correct if needed

Keep test cases focused and practical — test what the user built, not the entire app.

## Step 3: Open the App in Chrome

Use the `chrome-devtools` MCP tools. There is no "surface ID" — pages are tracked by the MCP server; use `list_pages` / `select_page` if you need to switch among tabs.

1. Open a new tab on the frontend URL:
   - `mcp__chrome-devtools__new_page` with `url = $FRONTEND_URL`
2. Wait for first paint / a known root element:
   - `mcp__chrome-devtools__wait_for` with a stable selector (e.g. the app root or sidebar)
3. Take an initial snapshot to anchor your interactions:
   - `mcp__chrome-devtools__take_snapshot`

## Step 4: Execute Test Cases

For each test case, follow this loop:

1. **Navigate** to the right part of the app
2. **Interact** — click buttons, fill forms, trigger the feature
3. **Verify** — take a snapshot or screenshot and check the result against expectations
4. **Record** — note pass/fail and any unexpected behavior

### chrome-devtools MCP tool map

| Action | Tool |
|--------|------|
| Open new tab at URL | `mcp__chrome-devtools__new_page` |
| Navigate current tab | `mcp__chrome-devtools__navigate_page` |
| List / switch tabs | `mcp__chrome-devtools__list_pages`, `mcp__chrome-devtools__select_page` |
| DOM snapshot (text) | `mcp__chrome-devtools__take_snapshot` |
| Screenshot (file) | `mcp__chrome-devtools__take_screenshot` |
| Click element | `mcp__chrome-devtools__click` |
| Type into focused input | `mcp__chrome-devtools__type_text` |
| Set a single field | `mcp__chrome-devtools__fill` |
| Set multiple fields | `mcp__chrome-devtools__fill_form` |
| Hover | `mcp__chrome-devtools__hover` |
| Drag | `mcp__chrome-devtools__drag` |
| Press a key | `mcp__chrome-devtools__press_key` |
| Wait for selector / state | `mcp__chrome-devtools__wait_for` |
| Run JS in page | `mcp__chrome-devtools__evaluate_script` |
| Console messages | `mcp__chrome-devtools__list_console_messages`, `mcp__chrome-devtools__get_console_message` |
| Network requests | `mcp__chrome-devtools__list_network_requests`, `mcp__chrome-devtools__get_network_request` |
| Native dialogs (alert/confirm) | `mcp__chrome-devtools__handle_dialog` |
| Resize viewport | `mcp__chrome-devtools__resize_page` |

Use `take_snapshot` liberally to understand current page state before interacting. Snapshots are cheap and prevent blind clicking.

After all interactions, always check the console — issues often surface there even when the UI looks fine:

```text
mcp__chrome-devtools__list_console_messages
```

If something behaved unexpectedly during startup or while testing, inspect the dev log too:

```bash
tail -n 200 /tmp/cadencr-qa/dev.log
```

### React controlled inputs

`fill` / `type_text` set the DOM value but do **not** always trigger React's synthetic `onChange` on controlled inputs (`value={state}`). The input looks updated but React's internal state is stale, so blur/submit handlers see the old value.

**Workaround** — use `evaluate_script` with the native value setter to fire a React-compatible `input` event:

```js
// mcp__chrome-devtools__evaluate_script
const input = document.querySelector('YOUR_SELECTOR');
const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
nativeSetter.call(input, 'NEW_VALUE');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

Then trigger blur/submit via another `evaluate_script` if needed:

```js
document.querySelector('YOUR_SELECTOR').blur();
```

### Tips

- Cadencr uses **hash routing** (`/#/...`), so URLs look like `$FRONTEND_URL/#/projects/1/features`.
- Prefer `take_snapshot` for structured DOM context; reach for `take_screenshot` (saved to e.g. `/tmp/qa-*.png`) when the bug is visual or when documenting failures.
- If a click "doesn't work," snapshot first — selectors drift as the UI changes.
- Use `wait_for` between an action and the assertion that follows it; do not rely on implicit timing.
- `evaluate_script` returns the value of the last expression, so it doubles as a read primitive (e.g. `document.querySelector(sel)?.textContent`).

## Step 5: Report Results

After running all test cases, produce a concise report in your reply (and the PR description when there is one). Never write it, its screenshots or check scripts to a tracked file such as `docs/qa/`; keep artifacts in your scratch directory.

```
## QA Report: [Feature Name]

**Result**: X/Y passed

### Failed
- **[Test case name]**: Expected [X], got [Y]. Screenshot: /tmp/qa-failure-1.png

### Passed
- [Test case name]
- [Test case name]

### Console Errors
- [Any errors found, or "None"]
```

Focus the report on failures — what broke and why. Passing tests get a one-liner each. If everything passed, say so and keep it short.

## Step 6: Clean Up Only What QA Started

If Step 1 found both servers already healthy, do **not** stop them.

If this QA run started the stack, stop that tracked process group at the end, even on failure:

```bash
if [ -f /tmp/cadencr-qa/dev.pgid ]; then
  DEV_PGID=$(cat /tmp/cadencr-qa/dev.pgid)
  kill -TERM -- "-$DEV_PGID" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-$DEV_PGID" 2>/dev/null || true
fi
```

Close any QA-opened tabs with `mcp__chrome-devtools__close_page` if they would otherwise clutter the user's browser.

Mention the log path in the final report if startup or runtime issues required inspection.
