# CadencR provider for Google Antigravity

This provider runs the Google Antigravity CLI (`agy acp`) through the
Agent Client Protocol. The Rust connector is packaged for the CadencR
Marketplace on macOS (Apple silicon and Intel) and Linux (ARM64 and x86-64).
Install and authenticate `agy` separately on the machine running CadencR.

## Set up the provider

1. Install [Google Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli).
2. Run `agy` in a terminal and complete [Google's sign-in flow](https://antigravity.google/docs/install?tab=cli).
3. From CadencR's Marketplace, install **Google Antigravity**, then select it as
   the provider for a project conversation.

The connector searches the absolute directories on CadencR's `PATH` in order,
then checks `$HOME/.local/bin/agy`. For a Marketplace or local installation,
set `ANTIGRAVITY_CLI_PATH` in the CadencR environment to the absolute path of
an executable `agy` file. Local installations also accept the legacy
`CADENCR_ANTIGRAVITY_COMMAND` variable when `ANTIGRAVITY_CLI_PATH` is unset
or empty.

The CLI manages authentication and credentials. You can start ACP sign-in
from a terminal with `agy acp --login`. Terminal resume resolves `agy`
through the terminal's `PATH`.

Saved conversation history remains available when CLI discovery fails.
CadencR keeps the saved permission mode in that case and validates it against
the provider's available modes before the next turn.

The package requires CadencR `0.16.4` or later for fixed-choice questions and
background reply status.

## Conversation controls

| Control                       | Source                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model picker                  | `agy models` supplies the signed-in account's catalog before a session.                                                                                                                                   |
| Thinking level and mode       | The cold catalog groups models with multiple thinking levels and reports the levels for each model. The live ACP session confirms the available choices. Some modes depend on account or sandbox support. |
| Questions                     | CadencR displays interactive questions as single-choice prompts. If Antigravity prints a numbered question in the chat, send the chosen number as a follow-up message.                                    |
| Permissions                   | CadencR shows the scope warning supplied by Antigravity for persistent grants.                                                                                                                            |
| Context usage                 | CadencR displays context usage when Antigravity reports it through ACP.                                                                                                                                   |
| Background subagents          | The launch appears as running while the child works. Its available tool activity and final reply summary appear under the launch.                                                                         |
| Background replies            | A background completion can post a follow-up after the prompt ends. The connector waits for a quiet interval after model usage and keeps the reply open across tool steps.                                |
| Session restore               | CadencR reopens the saved Antigravity session when the CLI advertises ACP session loading.                                                                                                                |
| Terminal resume               | CadencR can open a saved session in the Antigravity terminal with `agy --conversation <session-id>`.                                                                                                      |
| Slash commands and compaction | The composer lists ACP prompt commands and invocable skills before the first message. During a session it follows the CLI’s live catalog.                                                                 |
| Workspace instructions        | The connector declares `AGENTS.md`, `GEMINI.md`, and Antigravity configuration under `.agents/` for CadencR worktrees.                                                                                    |

The session info menu reports an attached CadencR MCP server as configured
until Antigravity requests its tools, connected while that MCP connection is
open, and disconnected after its last connection closes.

With a compatible agy 1.x CLI (1.5.0 or later), pressing Enter during a turn
sends a second ACP prompt to the same session. The agent can act on it while
an earlier command is still running. The message appears at its submission
position and shows a pending receipt until Antigravity ingests it into the
session transcript (or ACP settles the request). The composer's
queue action keeps a message for the end of the turn. A new major CLI version uses the queue until
its concurrent prompt behavior has been verified.

Antigravity's ACP stream acknowledges the launch before the child finishes.
The connector matches each new launch to its child's journal using the call ID
in the launch message, including when several children start in one model step.
The card shows the latest model recorded in that child’s planner responses and
the cumulative tokens from those responses (uncached input, cache reads and output).
The conversation stays working while a dispatched child, an awaited shell
command, or a scheduled task continues after a prompt. Tasks launched with
`IsDaemon: true` can keep serving after the turn ends. A port number or a
shell command's name does not establish that intent.
After an awaited task returns, the connector keeps the turn open for the
model's follow-up. When the parent journal shows that the model already acted
on that child's final report, the child releases its hold immediately. If agy
sends no fresh model content within 60 seconds and no task or reply is active,
the connector releases the conversation.
A child that yields to a timer or background command
stays running until it resumes and finishes. When a child delegates again,
the connector correlates the nested agent's final report with its delivery
to the child. An intermediate progress message keeps the child running.
If the connector cannot find a
readable child journal within 30 seconds, it releases that child's hold on the
conversation. The card retains the last observed status until its runtime closes.

The pre-session slash menu, prompt transcript receipts, and child-journal format are verified with
`agy 1.5.14`–`1.5.15`. After the session opens, ACP supplies the live command list.
When investigating missing commands or child actions, check `agy --version`
and the connector diagnostics. An unreadable optional skill or manifest is
skipped individually. The journal determines which actions CadencR can show. Parallel calls can appear without individually
attributed results.

**Auto** uses Antigravity’s native execution policy. Antigravity approves
workspace edits, runs terminal commands in its sandbox by default, and checks
commands that need to run outside the sandbox. Risky or irreversible actions
can still require approval. Auto requires a personal account and a supported
terminal sandbox. Choose it before the first turn or during an eligible
session. When the CLI declines Auto at startup, choose **Default** or another
available mode and resend. CadencR applies the selected mode again when it
restores a session. See [Antigravity execution modes](https://antigravity.google/docs/cli/modes/).

In Auto mode, Antigravity can still request approval for an MCP tool.
The `agy 1.5.14` ACP evaluator can classify even a read-only MCP call as
`unsupported_tool` and offer a one-time allow or deny decision. CadencR presents
that decision to the user. See [Antigravity CLI permissions](https://antigravity.google/docs/permissions#antigravity-cli).

## Build and test

From the repository root, with the pinned Node.js and Rust toolchains and
Python 3 installed:

```sh
pnpm run check:plugin:antigravity
pnpm run test:plugin:antigravity
pnpm run build:plugin:antigravity
pnpm run package:plugin:antigravity --directory /absolute/new/antigravity-payload
```

The integration tests exercise ACP against a scripted `agy`. The package
command builds the host-native release executable and stages `bin/provider`,
`README.md`, `LICENSE`, and `icon.svg`, with a sibling `SHA256SUMS` file.
The executable and staged output are generated files.

## Marketplace release

The [native build workflow](../../../.github/workflows/cursor-provider-build.yml)
builds the four declared targets, runs the scripted integration tests against
each exact distribution executable, and produces the canonical archives,
`package.json`, `submission.json`, and a release request using the pinned
CadencR CLI. Its evidence covers the scripted connector contract. Real CLI
sign-in, hosted model calls, and installation from the signed marketplace
require separate verification.

1. Once the reviewed source is on `main`, bind
   `plugins/provider-antigravity/v0.1.0` to that exact commit. The tag starts
   **Build and qualify native provider release artifacts**. To run the build
   manually, select `provider: antigravity` and a ref at the same commit.
2. Dispatch **Publish a qualified native provider connector** from `main`
   with `provider: antigravity`, the source commit, the successful native
   build run, and sixty-four zeros for `request_sha256`.
3. Review the assembled archives and marketplace documents. Dispatch again
   with the inspected request digest and obtain the existing protected
   environment approval. The workflow reconstructs the exact request before
   publishing the GitHub assets.
4. Submit the generated package and submission documents through the CadencR
   [registry contribution flow](../../../tooling/marketplace-registry/AUTHORING.md).
   After catalog signing and admission, verify managed installation and a real
   authenticated turn on the declared platforms.

If the fixed-choice question support first ships in a later CadencR release,
update `min_app_version` in the package template before qualifying the source.

## Connector artwork

The provider uses the [Google Antigravity mark](https://antigravity.google/favicon.svg)
with a transparent background so CadencR can tint its silhouette in the sidebar.
Google owns the mark. The connector’s Apache-2.0 license applies to its code.
