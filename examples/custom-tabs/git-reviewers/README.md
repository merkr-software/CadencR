# Git reviewers

A **runs commands** custom tab: it lists the people who know the code
this branch changes — who committed to each changed file on the base branch —
so you can pick reviewers. The Cadencr API gives the changed files; the
history comes from `git log`, which Cadencr runs for the tab.

## The command

`tab.json` lists the one program the tab may run, with the reason the user
reads before allowing it:

```json
"permissions": ["git:read"],
"commands": [
  {
    "program": "git",
    "reasoning": "Reads who changed each file this branch touches (git log) and your own Git identity (git config user.email), in this conversation's folder."
  }
]
```

The tab calls it through the SDK:

```ts
const result = await client.exec.run("git", [
  "log",
  "main",
  "--no-merges",
  "-n60",
  "--format=%aE%x09%aN%x09%at",
  "--",
  path,
]);
// { exitCode, success, stdout, stderr, durationMs }
```

Cadencr runs `git` from your `PATH`, without a shell, in the conversation's
folder, with a 30 s timeout and 1 MiB of output per stream. A non-zero exit
resolves (`success: false`); a program that is not listed rejects with
`PLUGIN_EXEC_DENIED`. At most four commands run at once per tab, so the tab
reads three files at a time (`useReviewers.ts`).

## What the user sees

- **Settings → Custom tabs**: a "Runs commands" badge, and `git` with its
  reason under the permissions. The consent dialog says the tab asks Cadencr
  to run programs on the computer.
- **The tab strip**: a terminal glyph on the tab and in the **+** menu.
- **+ → Activity…**: every `git` command the tab ran here, with its arguments,
  exit code and duration — and any command Cadencr refused.

## Files

| File                  | What it does                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| `src/useReviewers.ts` | Changed files from the API, `git log` per file (3 at a time), live on `git.status`. |
| `src/model.ts`        | Parses `git log` lines and ranks people by changed files, then commits.             |
| `src/App.tsx`         | The list, the empty and error states, and the tab badge.                            |

Build and install it like the other examples ([README](../README.md)).
