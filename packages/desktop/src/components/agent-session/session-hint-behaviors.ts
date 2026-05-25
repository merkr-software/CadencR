/**
 * Static catalog of "Did you know?" behaviors surfaced on the new-session
 * empty state, paired dynamically with a random keyboard shortcut from
 * `lib/shortcuts/registry` to teach users how Cadencr works.
 *
 * Keep entries:
 *  - Factual — every line must describe an actual app behavior.
 *  - Self-contained — readable in one short paragraph, no follow-up needed.
 *  - Provider-neutral — no claim that only applies to one agent backend
 *    unless explicitly framed that way.
 *
 * Order is not significant; the consumer picks at random.
 */
export const SESSION_HINT_BEHAVIORS: readonly string[] = [
  "Cadencr wraps multiple AI coding agents — Claude Code, OpenCode, and Codex — behind a single workspace, so your shortcuts and layout stay the same when you swap providers.",
  "Each feature can run on its own git worktree, letting different agents work on different branches without stepping on each other.",
  "Plans must be approved before they execute. You can approve, request changes with feedback, or reject — the agent waits for your call.",
  "Auto-scroll pauses the moment you scroll up to read older output, and a chip appears so you can snap back to the live tail.",
  "Permission modes are per-agent: pick stricter guardrails for risky tasks and looser ones when you just want it to ship.",
  "When an agent needs a decision, it asks a multiple-choice question inline — type the number, press Enter, or open the “Other…” field to write your own answer.",
  "The Diff viewer borrows vim-style keys, so you can sweep through changes without leaving the keyboard.",
  "You can mark files as viewed in the Diff viewer, the same way you would on a GitHub pull request — perfect for big reviews.",
  "Diff comments queue up locally and are sent to the agent in one batch, so you can write a full review before triggering another turn.",
  "The Editor tab is a real text editor with fuzzy file search and a togglable file explorer — handy for quick fixes without leaving Cadencr.",
  "The Editor previews Markdown, HTML, SVG, and image files in place, so agent-generated docs and visual assets are easy to inspect without leaving the workspace.",
  "The Terminal can be split horizontally or vertically, and you can hop between panes with the same arrow-based shortcut family used in the Editor.",
  "The Unified Agents view shows every running agent across every feature on a single grid, so nothing slips off your radar.",
  "You can pin an agent in the Unified Agents view to keep it at the top while you scan everything else.",
  "Every agent surfaces live context-window usage, so you know when it’s time to compact instead of being surprised mid-turn.",
  "The branch picker is a fast checkout: start typing a branch name and press Enter to switch — no terminal round-trip.",
  "Commits, pushes, and pull requests each have a dedicated dialog, so the entire git flow lives next to the agent that produced it.",
  "The command palette is the fastest way to jump between features, projects, and actions — most things you can do via menu are there too.",
  "Slash commands work in the prompt. Type `/` to discover what’s registered for the current project.",
  "You can paste images directly into the prompt — screenshots, mockups, and diagrams attach inline without saving to disk first.",
  "The thinking-effort chip lets you trade speed for depth on models that support reasoning, and the choice sticks per agent.",
  "The model picker groups providers and their models together, so swapping is a single keystroke instead of a settings hunt.",
  "Cadencr is provider-neutral: switching between Claude Code, OpenCode, and Codex preserves your workspace, history, and shortcuts.",
  "Need to bail out fast? One shortcut stops every running agent across every feature at once.",
  "Content search runs inside the current feature’s working directory only — fast, focused, and never bleeds across projects.",
  "The sidebar can be toggled to give the agent stream more breathing room when you’re deep in a long turn.",
  "Zoom controls work app-wide, so you can scale the UI for shared screens or presentations without restarting.",
  "You can rename a feature’s label inline so it shows up in the command palette under a name that actually means something.",
  "Each feature has a settings popover for runtime, working directory, and permission defaults — change them without touching JSON.",
  "The keyboard shortcuts modal is searchable: try a description like “zoom”, a topic like “git”, or even the chord itself such as “⌘ k”.",
  "Agents can be collapsed or maximized inline, so you can park one mid-thought and bring another to full screen without losing state.",
  "The sidebar shows status dots on every project and feature, so you can spot which agent is busy without opening anything.",
  "Sessions are resumable — if an agent stops mid-task, a Resume button picks the conversation back up right where it left off.",
  "Tool-permission prompts can be granted just for this one request or for the rest of the session, so trust scales with familiarity.",
  "Rejecting a plan isn't all-or-nothing — you can write feedback and send the agent back to revise instead of starting over.",
  "Each feature can host multiple agents stacked vertically, so you can compare answers or hand off work between providers.",
  "The Diff viewer's file sidebar can collapse for a full-width review, then expand again when you need to jump between files.",
  "From the Diff viewer you can open the focused file straight into the Editor tab to tweak it manually, without losing your scroll position.",
  "Question drawers always include an “Other…” field — when the agent's multiple choices don't fit, you can type a free-text answer.",
  "Every pane has a dedicated tab shortcut — Agent, Terminal, Git, and Editor — so swapping roles never needs the mouse.",
  "The Editor handles multiple file tabs at once, with separate chords to step next, previous, and close — like a tiny IDE inside the IDE.",
  "Pane navigation is consistent everywhere: the same modifier + arrow keys move focus in the Editor, the Terminal, and the Unified Agents grid.",
  "Open Settings with one shortcut, edit what you need, and press Esc to drop straight back into the workspace.",
  "Status colors are reserved across the whole app: green means ready, orange means in-progress, red means retry — they never mean anything else.",
  "The keyboard-shortcuts reference is always one chord away (⌘⇧?), so you can look up a binding mid-stream without losing your place.",
  "Archived features still live in the command palette — archive is a soft delete, so you can restore them later if you change your mind.",
  "You can run different agents on different providers at the same time — one feature on Claude Code, another on OpenCode — and the workspace stays consistent.",
  "The Unified Agents grid lets you arrow-key between every active session across every feature, so a busy workspace stays scannable.",
  "Swapping models mid-conversation doesn't reset the agent — the context stays, only the writer changes.",
  "When the agent queues multiple questions in a row, the question drawer lets you walk through them with ← and → before submitting answers.",
  "The branch chip doubles as a checkout: it shows the current branch and switches you to a new one in the same popover.",
] as const;
