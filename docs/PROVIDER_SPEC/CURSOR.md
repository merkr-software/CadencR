# Provider status — Cursor

> Reviewed on 2026-11-01 when the built-in Cursor adapter was extracted into an
> external provider plugin. This is a source/design review of the new boundary,
> not an end-to-end parity certification of every Cursor CLI release.

Status of the Cursor provider against [`FEATURES.md`](./FEATURES.md).

Cursor is no longer a built-in Cadencr adapter. It ships as an **official
marketplace provider plugin**: a Rust ACP v1 connector whose source lives in
`plugins/providers/cursor/`. The service, desktop app, and SDK crates contain no
Cursor code: there is no `domain/agents/cursor/` adapter, no
`cursor-agent-sdk-rs` crate, no Cursor CLI discovery, and no `cursor_cli_path`
setting. The workspace access default uses the provider-neutral
`provider_access_mode.cursor` key; at startup the host copies a former
`cursor_access_mode` value there once, unless the new key is already set.

The plugin installs through the same generic installed-provider path as the Pi
connector (`plugins/providers/pi/`): a signed package with a descriptor, the
connector executable, and a connector-owned `icon.svg` that the runtime catalog
serves to the desktop. The provider id stays `cursor`, so existing Cursor
conversations keep their provider identity once the plugin is installed.
Cadencr runs the connector through `GenericAcpAdapter`. Nothing in shared host
code branches on the `cursor` id.

## Install

1. Install and authenticate the Cursor Agent CLI:

   ```bash
   curl https://cursor.com/install -fsS | bash
   agent login
   ```

2. Install **Cursor** from the Cadencr marketplace (**Providers**), then restart
   Cadencr when prompted.

The connector finds and launches `agent acp` itself. Credentials stay with the
Cursor CLI. Cadencr does not collect or broker them.

## Connector-owned translation

The connector speaks the Cursor CLI's ACP dialect (including the `cursor/*`
extension methods) and presents standard ACP v1 to Cadencr. All Cursor-specific
behavior lives in the connector:

- **Model discovery and companion folding.** The connector answers the host's
  pre-session model discovery from `agent models`. It advertises
  `clientCapabilities._meta.parameterizedModelPicker` to Cursor and folds
  Cursor's variant ids and companion options (`fast`, thought level) into a base
  model plus standard ACP session config options. Cursor replaces the companion
  set when the base model changes, so the connector re-resolves companions from
  the model-change response.
- **Modes through `_meta.cadencr.permissionMode`.** Cursor's own `mode` select
  (`category: "mode"`) passes through with each known value mapped:
  `agent` → `default` (primary edit mode), `plan` → `plan`, `ask` → `ask`.
  The cold `models` output carries the same select, so the host catalog and
  live snapshots agree.
- **Access mode as a synthetic config option.** Cursor ACP has no approval-mode
  config option, so the connector advertises its own `access` select, marked
  `_meta.cadencr.role: "access_mode"`: **Default** (`default`,
  `--sandbox enabled`), **Full Access** (`full_access` → `fullAccess`,
  `--force --sandbox disabled`), or **Auto Review** (`auto_review` →
  `autoReview`, `--auto-review --sandbox enabled`), each value carrying
  `_meta.cadencr.accessMode`; the cold `models` output carries it too. A change
  that alters launch flags restarts the Cursor CLI and restores the
  conversation with `session/load`. Cursor saves a new conversation only when
  its first prompt runs, so a switch into Full Access before that prompt is
  deferred: the connector answers that turn's permission requests
  `allow_once` (sandbox still on) and restarts with Full Access before
  answering the turn. Leaving Full Access before a new conversation's first
  prompt is refused with an error.
- **Auto Review preflight.** Cursor's ACP bootstrap does not yet honor
  `--auto-review`, so the connector answers `allow_once` for a plain shell
  allowlist miss. A request that carries a stronger reason (parser, sandbox,
  blocklist, delete protection, hook, or team policy) stays interactive. MCP and
  other non-shell gates also stay interactive.
- **`cursor/*` extensions mapped to standard ACP:**

  | Cursor method           | What Cadencr receives                                                                                                                                      |
  | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `cursor/update_todos`   | Standard ACP `plan` session updates, rendered as the todo list.                                                                                            |
  | `cursor/ask_question`   | A `session/request_permission` for an `AskUserQuestion` tool call. The host returns the user's answers in the selected option's `_meta.updatedInput`.      |
  | `cursor/create_plan`    | A `session/request_permission` for an `ExitPlanMode` tool call, which opens Cadencr's plan gate. Feedback uses the same `_meta.updatedInput` convention.   |
  | `cursor/task`           | A standard tool call carrying the sub-agent metadata. A task Cursor reports as `rawOutput.isBackground` gets `_meta.cadencr.subagent: {background: true}`. |
  | `cursor/generate_image` | A standard tool call preserving the generated-image payload.                                                                                               |

- **Host integration.** `host-integration --format cadencr-host-integration-v1`
  declares only `worktreeConfigPaths` (`.cursor/rules`, `.cursor/commands`,
  `.cursor/skills`, `.cursor/mcp.json`, `.cursor/cli.json`). It declares no
  `compactCommand`: Cursor Agent 2026.10.22's ACP server has no compaction
  command (`/compress` and `/summarize` are interactive-TUI only; over ACP
  `/compress` is an ordinary prompt). It declares no `resumeCommand`: ACP
  sessions live in `~/.cursor/acp-sessions/<id>`, apart from interactive
  chats, and `agent --resume <ACP session id>` opens an empty chat instead of
  the conversation.
- **Slash commands.** `slash-commands --format cadencr-slash-commands-v1`
  rebuilds, without starting `agent acp`, the list Cursor Agent 2026.10.22's
  ACP server sends in `available_commands_update` (its `custom-commands.ts`
  loader, read from the CLI bundle and checked against live frames):
  `copy-request-id`; `.claude/commands/*.md` and `.cursor/commands/*.md` of the
  project root (nearest ancestor with `.git`, else the cwd), then the same
  under `~` — title = first line's heading or text, description
  `<title> (project)` / `(user)`, a later file with the same name replacing an
  earlier one in place; then skills (`SKILL.md`, recursive) of
  `~/.cursor/skills-cursor`, the project's `.cursor`, `.claude`, `.codex`,
  `.grok`, `.agents` `skills/`, then the same under `~`, with
  `(builtin skill)` / `(project skill)` / `(user skill)` suffixes, the folder
  name as id, `user-invocable: false` and non-CLI `metadata.surfaces` hidden.
  Probed live on 2026-11-01 in two scratch repositories (52 and 50 entries,
  real user skills included): after removing the server-side entries, the
  connector's output matched name, description and order exactly. The proxy
  applies the same normalization to live `available_commands_update` frames:
  names with whitespace (listed by Cursor but not invocable) are dropped,
  duplicate names (a command and a skill called alike) keep the first entry,
  and skills get `_meta.cadencr.kind: "skill"`.
- **Sub-agents.** The connector negotiates Cursor's
  `clientCapabilities.subagents`: the child's tool calls reach Cadencr nested
  under the launching `Agent` call (`parentToolCallId`), and a background
  run's end (`subagent_state_update`) finishes it with
  `_meta.cadencr.subagent.status` and the child's last text as summary. With
  this capability Cursor holds the turn open until background runs finish,
  then adds a summary message (58 s instead of 9 s for a `sleep 40` run,
  measured live).
- **Plan follow-up inside the same turn.** After the user accepts a plan, the
  connector switches Cursor from `plan` to `agent` mode and sends the execution
  follow-up within the same ACP prompt turn. Cadencr does not need a
  provider-specific post-approval step.

## Status matrix

| #   | Feature                                  | Status | Notes                                                                                                                                                                                                               |
| --- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Modes: agent / plan / ask                | ✅     | The `mode` select's values carry `_meta.cadencr.permissionMode`, so the host mode chip and Shift+Tab cycle Agent → Plan → Ask, and agent-initiated switches move the chip.                                          |
| 2   | Thinking                                 | ✅     | Standard ACP `agent_thought_chunk` updates.                                                                                                                                                                         |
| 3   | Partial / streaming messages             | ✅     | Shared ACP message, thought, tool-call, and completion indexing.                                                                                                                                                    |
| 4   | Bash tool calls + outputs                | ✅     | The connector normalizes Cursor shell/terminal calls to standard ACP tool calls before they reach the host.                                                                                                         |
| 5   | Edits / Writes / Patch                   | ✅     | Standard ACP diff content and tool kinds.                                                                                                                                                                           |
| 6   | Sub-agents                               | ✅     | `cursor/task` metadata becomes a standard `Agent` tool call; the child session's tool calls nest under it live, and background runs end with Cursor's `subagent_state_update`.                                      |
| 7   | Todo                                     | ✅     | `cursor/update_todos` becomes standard ACP `plan` updates.                                                                                                                                                          |
| 8   | Thinking level changes                   | 🟡     | Thought-level companions become standard ACP config options when Cursor exposes them for the selected model.                                                                                                        |
| 9   | Model selection changes                  | ✅     | Pre-session discovery from `agent models`; live changes use the advertised config option values after companion folding.                                                                                            |
| 10  | Permissions: yes / no / always / session | ✅     | Standard `session/request_permission`. The access chip and the remembered workspace default drive the connector's `access_mode` option, applied by restarting and restoring with `session/load`.                    |
| 11  | MCP                                      | 🟡     | Runtime MCP servers pass through standard ACP session requests. Status stays `unknown`.                                                                                                                             |
| 12  | Plan approval                            | ✅     | `cursor/create_plan` becomes an `ExitPlanMode` permission request. The execution follow-up runs inside the same turn.                                                                                               |
| 13  | Context usage                            | ❌     | Cursor ACP exposes no authoritative context occupancy. Nothing is guessed.                                                                                                                                          |
| 14  | Compaction                               | ❌     | Cursor's ACP server has no compaction command, so the connector declares no `compactCommand` and the host offers no `/compact` action. Typing `/compress` sends it to Cursor as an ordinary prompt.                 |
| 15  | Command + skill list                     | ✅     | `slash-commands` rebuilds Cursor's own list from the filesystem before any session (identical to live `available_commands_update` in probes); server-side team/global commands appear after the first live session. |
| 16  | Live follow-up prompt targeting          | ✅     | Follow-ups reuse the live ACP `sessionId`.                                                                                                                                                                          |
| 17  | Durable session restore                  | ✅     | `session/load` when Cursor advertises `loadSession`.                                                                                                                                                                |

Legend: ✅ implemented · 🟡 partial · ❌ missing.

## Changes from the former built-in adapter

- **Access default key.** The workspace default moved from `cursor_access_mode`
  to `provider_access_mode.cursor`; the host carries an existing value over
  once at startup and keeps the old key. The composer access chip and the
  Settings → Providers Cursor row work as before, from the catalog.
- **No `/compact` action.** The built-in adapter offered `/compact` and sent
  `/compress`, which Cursor's ACP server treats as an ordinary prompt, so it
  never compacted. The action is no longer offered.
- **No terminal resume command.** The built-in "resume in terminal" shortcut
  ran `agent --resume <id>` with the ACP session id, which opens an empty chat.
  The connector declares no `resumeCommand`, so the shortcut is not offered.
- **Worktree config copy and slash commands come from the connector.** The
  `.cursor/*` worktree paths come from `host-integration`, and the pre-session
  `/` list from `slash-commands`, instead of built-in host code.
- **Attachments follow the advertised prompt capabilities.** Images and PDFs
  are offered only when Cursor's `initialize` advertises `image` /
  `embeddedContext`; text-like files are always accepted.
- **CLI lookup.** The first executable `agent` found on `PATH`, then in the
  installer and well-known directories, is used, as a shell would. The
  built-in adapter ran `agent --version` on every candidate and kept the
  newest; the connector skips that probe (one Node start per candidate on
  every launch). `CADENCR_CURSOR_COMMAND` pins a specific executable.
- **Plugin icon.** The bundled desktop Cursor logo was removed. The icon comes
  from the connector's `icon.svg` through the runtime catalog.
- **Existing sessions.** Conversations created by the built-in adapter keep the
  `cursor` provider id. They resume only after the plugin is installed and only
  where Cursor's `session/load` still accepts the stored session id.

## Known upstream/contract limitations

1. Cursor's ACP model/config surface has changed across CLI releases. The
   connector, not Cadencr, absorbs those changes.
2. Cursor reports no context occupancy.
3. A sub-agent's own text is kept only as its summary; Cadencr shows its tool
   calls live, not its messages, and drops its own todo list and plans so they
   don't replace the parent's.
4. Composer may not emit `cursor/ask_question` for a given turn. A prompt cannot
   force an unavailable tool.
5. Native Read/Search starts omit ACP `locations` and raw arguments, so the ACP
   title is the only trustworthy description.
6. Cursor does not implement the `SessionBranching` capability for
   [Rewind & Fork](../REWIND_AND_FORK.md).
7. Team commands and Cursor's "global" commands (`(team)` / `(global)`, e.g.
   `/worktree`, `/best-of-n`, `/simplify`) come from Cursor's dashboard API,
   not the filesystem, so `slash-commands` cannot list them. Cadencr appends
   them from the last live session in that directory (in memory, per service
   process). Cursor plugin skills are not in the ACP list either (the ACP
   server loads commands without its plugin service). The connector uses name
   order where Cursor uses raw directory order, and a YAML subset where Cursor
   uses js-yaml: exotic frontmatter (anchors, flow mappings) may be read
   differently.
