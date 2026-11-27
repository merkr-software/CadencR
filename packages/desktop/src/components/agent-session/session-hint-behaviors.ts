import type { UiTranslator } from "@/lib/i18n/ui";
import { SESSION_WORKSPACE_HINTS } from "./session-hint-workspace";

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
export const SESSION_HINT_BEHAVIORS: readonly ((t: UiTranslator) => string)[] = [
  (t) =>
    t(
      "conversation.stream.sessionTips.cadencrWrapsMultipleAiCodingAgentsClaude",
      "Cadencr wraps multiple AI coding agents — Claude Code, OpenCode, and Codex — behind a single workspace, so your shortcuts and layout stay the same when you swap providers.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.eachFeatureCanRunOnItsOwn",
      "Each feature can run on its own git worktree, letting different agents work on different branches without stepping on each other.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.plansMustBeApprovedBeforeTheyExecute",
      "Plans must be approved before they execute. You can approve, request changes with feedback, or reject — the agent waits for your call.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.autoScrollPausesTheMomentYouScroll",
      "Auto-scroll pauses the moment you scroll up to read older output, and a chip appears so you can snap back to the live tail.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.permissionModesArePerAgentPickStricter",
      "Permission modes are per-agent: pick stricter guardrails for risky tasks and looser ones when you just want it to ship.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.whenAnAgentNeedsADecisionIt",
      "When an agent needs a decision, it asks a multiple-choice question inline — type the number, press Enter, or open the “Other…” field to write your own answer.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theDiffViewerBorrowsVimStyleKeys",
      "The Diff viewer borrows vim-style keys, so you can sweep through changes without leaving the keyboard.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.youCanMarkFilesAsViewedIn",
      "You can mark files as viewed in the Diff viewer, the same way you would on a GitHub pull request — perfect for big reviews.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.diffCommentsQueueUpLocallyAndAre",
      "Diff comments queue up locally and are sent to the agent in one batch, so you can write a full review before triggering another turn.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorTabIsARealText",
      "The Editor tab is a real text editor with fuzzy file search and a togglable file explorer — handy for quick fixes without leaving Cadencr.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorPreviewsMarkdownHtmlSvgAnd",
      "The Editor previews Markdown, HTML, SVG, and image files in place, so agent-generated docs and visual assets are easy to inspect without leaving the workspace.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theTerminalCanBeSplitHorizontallyOr",
      "The Terminal can be split horizontally or vertically, and you can hop between panes with the same arrow-based shortcut family used in the Editor.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theUnifiedAgentsViewShowsEveryRunning",
      "The Unified Agents view shows every running agent across every feature on a single grid, so nothing slips off your radar.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.youCanPinAnAgentInThe",
      "You can pin an agent in the Unified Agents view to keep it at the top while you scan everything else.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.everyAgentSurfacesLiveContextWindowUsage",
      "Every agent surfaces live context-window usage, so you know when it’s time to compact instead of being surprised mid-turn.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theBranchPickerIsAFastCheckout",
      "The branch picker is a fast checkout: start typing a branch name and press Enter to switch — no terminal round-trip.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.beforeTheFirstPromptTheWorktreeMode",
      "Before the first prompt, the worktree mode picker lets you choose a new branch, reuse an existing worktree, or defer a checkout until the session starts.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.commitsPushesAndPullRequestsEachHave",
      "Commits, pushes, and pull requests each have a dedicated dialog, so the entire git flow lives next to the agent that produced it.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theGitTabHasACommitGraph",
      "The Git tab has a commit graph, so you can see where the session branch sits before you review, push, or open a pull request.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theCommandPaletteIsTheFastestWay",
      "The command palette is the fastest way to jump between features, projects, and actions — most things you can do via menu are there too.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.slashCommandsWorkInThePromptType",
      "Slash commands work in the prompt. Type `/` to discover what’s registered for the current project.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.youCanPasteImagesDirectlyIntoThe",
      "You can paste images directly into the prompt — screenshots, mockups, and diagrams attach inline without saving to disk first.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.promptAttachmentsAreProviderAwareImagesPdfs",
      "Prompt attachments are provider-aware: images, PDFs, and other files are sent in the shape each agent backend expects.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theThinkingEffortChipLetsYouTrade",
      "The thinking-effort chip lets you trade speed for depth on models that support reasoning, and the choice sticks per agent.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.unsupportedThinkingEffortChoicesAreClearedAutomatically",
      "Unsupported thinking-effort choices are cleared automatically on models that do not accept them, avoiding a failed first turn.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theModelPickerGroupsProvidersAndTheir",
      "The model picker groups providers and their models together, so swapping is a single keystroke instead of a settings hunt.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.claudeCodeProfilesCanBeSelectedBefore",
      "Claude Code profiles can be selected before the first turn, so Bedrock, Vertex, or local environment overrides are in place before the CLI starts.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.cadencrIsProviderNeutralSwitchingBetweenClaude",
      "Cadencr is provider-neutral: switching between Claude Code, OpenCode, and Codex preserves your workspace, history, and shortcuts.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.existingClaudeCodeOpencodeAndCodexConversations",
      "Existing Claude Code, OpenCode, and Codex conversations can be imported, so older work can become part of your Cadencr workspace.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.needToBailOutFastOneShortcut",
      "Need to bail out fast? One shortcut stops every running agent across every feature at once.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.contentSearchRunsInsideTheCurrentFeature",
      "Content search runs inside the current feature’s working directory only — fast, focused, and never bleeds across projects.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.inConversationSearchFindsTextInsideThe",
      "In-conversation search finds text inside the current agent transcript, which is faster than scrolling when you remember what was said.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theSidebarCanBeToggledToGive",
      "The sidebar can be toggled to give the agent stream more breathing room when you’re deep in a long turn.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theSidebarKeepsPinnedConversationsInOne",
      "The sidebar keeps pinned conversations in one global section, so the sessions you care about stay visible across projects.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.finishedAgentsGetAnUnreadDotIn",
      "Finished agents get an unread dot in the sidebar, making it easier to spot sessions that completed while you were elsewhere.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.shellAndBrowserActivityIndicatorsInThe",
      "Shell and browser activity indicators in the sidebar show which features still have live terminals or Browser tabs open.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.zoomControlsWorkAppWideSoYou",
      "Zoom controls work app-wide, so you can scale the UI for shared screens or presentations without restarting.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.youCanRenameAFeatureSLabel",
      "You can rename a feature’s label inline so it shows up in the command palette under a name that actually means something.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.eachFeatureHasASettingsPopoverFor",
      "Each feature has a settings popover for runtime, working directory, and permission defaults — change them without touching JSON.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.globalAndProjectSettingsAreStoredAs",
      "Global and project settings are stored as readable JSON files, so configuration is easier to inspect, back up, and move between machines.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theKeyboardShortcutsModalIsSearchableTry",
      "The keyboard shortcuts modal is searchable: try a description like “zoom”, a topic like “git”, or even the shortcut chord itself.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.agentsCanBeCollapsedOrMaximizedInline",
      "Agents can be collapsed or maximized inline, so you can park one mid-thought and bring another to full screen without losing state.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theSidebarShowsStatusDotsOnEvery",
      "The sidebar shows status dots on every project and feature, so you can spot which agent is busy without opening anything.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.sessionsAreResumableIfAnAgentStops",
      "Sessions are resumable — if an agent stops mid-task, a Resume button picks the conversation back up right where it left off.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.compactionNowHasItsOwnInProgress",
      "Compaction now has its own in-progress state, so you can tell when a provider is shrinking context instead of assuming the agent is idle.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.toolPermissionPromptsCanBeGrantedJust",
      "Tool-permission prompts can be granted just for this one request or for the rest of the session, so trust scales with familiarity.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.rejectingAPlanIsnTAllOr",
      "Rejecting a plan isn't all-or-nothing — you can write feedback and send the agent back to revise instead of starting over.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.eachFeatureCanHostMultipleAgentsStacked",
      "Each feature can host multiple agents stacked vertically, so you can compare answers or hand off work between providers.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.projectAndWorkspaceMcpToolsLetCapable",
      "Project and workspace MCP tools let capable agents inspect nearby sessions, compare work, and search conversation history when you enable them.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theDiffViewerSFileSidebarCan",
      "The Diff viewer's file sidebar can collapse for a full-width review, then expand again when you need to jump between files.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.fromTheDiffViewerYouCanOpen",
      "From the Diff viewer you can open the focused file straight into the Editor tab to tweak it manually, without losing your scroll position.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.questionDrawersAlwaysIncludeAnOtherField",
      "Question drawers always include an “Other…” field — when the agent's multiple choices don't fit, you can type a free-text answer.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.everyPaneHasADedicatedTabShortcut",
      "Every pane has a dedicated tab shortcut — Agent, Terminal, Git, and Editor — so swapping roles never needs the mouse.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorHandlesMultipleFileTabsAt",
      "The Editor handles multiple file tabs at once, with separate chords to step next, previous, and close — like a tiny IDE inside the IDE.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorOpensVeryLargeFilesIn",
      "The Editor opens very large files in read-only mode, keeping multi-megabyte logs or generated files inspectable without freezing the workspace.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.modifierClickReferencesSymbolsAndRenameUse",
      "Modifier-click, references, symbols, and rename use LSP when available, turning the Editor into a lightweight navigation surface for real code.",
    ),
  ...SESSION_WORKSPACE_HINTS,
];
