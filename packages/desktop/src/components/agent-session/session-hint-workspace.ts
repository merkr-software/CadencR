import type { UiTranslator } from "@/lib/i18n/ui";

export const SESSION_WORKSPACE_HINTS: readonly ((t: UiTranslator) => string)[] = [
  (t) =>
    t(
      "conversation.stream.sessionTips.theFileTreeUsesLazyLoadingFor",
      "The file tree uses lazy loading for large worktrees, so ignored or massive folders do not make opening the Editor feel heavy.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theFileSearchTriggerInTheEditor",
      "The file search trigger in the Editor header is the fastest way to jump to a path without expanding folders by hand.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.paneNavigationIsConsistentEverywhereTheSame",
      "Pane navigation is consistent everywhere: the same modifier + arrow keys move focus in the Editor, the Terminal, and the Unified Agents grid.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theBrowserTabKeepsLocalhostChecksBeside",
      "The Browser tab keeps localhost checks beside the agent, with console and network diagnostics tied to the same feature.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.browserTabsAreScopedPerFeatureSo",
      "Browser tabs are scoped per feature, so opening test pages for one task does not leak into another session's workspace.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.ifBrowserMcpIsEnabledAgentsCan",
      "If browser MCP is enabled, agents can open local pages, inspect snapshots, and interact with the Browser tab under permission control.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.browserReloadAndPageZoomShortcutsWork",
      "Browser reload and page-zoom shortcuts work inside Cadencr, so web QA does not require jumping to an external browser.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.openSettingsWithOneShortcutEditWhat",
      "Open Settings with one shortcut, edit what you need, and press Esc to drop straight back into the workspace.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.remoteAccessLetsAPairedBrowserOr",
      "Remote access lets a paired browser or PWA watch and steer the same local sessions when you are away from this computer.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.remoteNotificationsCanAlertAPairedDevice",
      "Remote notifications can alert a paired device when a session finishes or needs attention.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.statusColorsAreReservedAcrossTheWhole",
      "Status colors are reserved across the whole app: green means ready, orange means in-progress, red means retry — they never mean anything else.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theKeyboardShortcutsReferenceIsAlwaysOne",
      "The keyboard-shortcuts reference is always one chord away, so you can look up a binding mid-stream without losing your place.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.archivedFeaturesStillLiveInTheCommand",
      "Archived features still live in the command palette — archive is a soft delete, so you can restore them later if you change your mind.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.archiveAndDeleteDialogsCanKillFeature",
      "Archive and delete dialogs can kill feature terminals too, helping cleanup finish without stray shells still running in the background.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.scheduledMessagesCanSendLaterAsLong",
      "Scheduled messages can send later as long as Cadencr is running, which is handy after a build, deploy, or human waiting period.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.youCanRunDifferentAgentsOnDifferent",
      "You can run different agents on different providers at the same time — one feature on Claude Code, another on OpenCode — and the workspace stays consistent.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theUnifiedAgentsGridLetsYouArrow",
      "The Unified Agents grid lets you arrow-key between every active session across every feature, so a busy workspace stays scannable.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theUnifiedAgentsFilterSupportsExcludeAnd",
      "The Unified Agents filter supports `/exclude:` and per-card hide actions when one noisy session should disappear from the current scan.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theUnifiedAgentsViewCanCreateA",
      "The Unified Agents view can create a new session directly with a project picker, no sidebar detour required.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.swappingModelsMidConversationDoesnTReset",
      "Swapping models mid-conversation doesn't reset the agent — the context stays, only the writer changes.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.whenTheAgentQueuesMultipleQuestionsIn",
      "When the agent queues multiple questions in a row, the question drawer lets you walk through them with ← and → before submitting answers.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theBranchChipDoublesAsACheckout",
      "The branch chip doubles as a checkout: it shows the current branch and switches you to a new one in the same popover.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.customActionsShowLiveOutputAndCan",
      "Custom actions show live output and can be stopped from the header, so long-running project scripts are easier to supervise.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.customActionsCanRunInATerminal",
      "Custom actions can run in a terminal split when you want the command output to stay visible beside the rest of the session.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.themeChoicesNowIncludeNewerLightAnd",
      "Theme choices now include newer light and dark palettes like Frost, Monokai, Carbon Owl, and Paper Owl, while keeping the same layout.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.hoverAnyMessageYouSentAndPick",
      "Hover any message you sent and pick Rewind to roll the conversation back to that point — everything after it is undone, including the agent's edits.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.forkTurnsOneOfYourEarlierMessages",
      "Fork turns one of your earlier messages into a brand-new session, so you can explore a second approach without losing the original thread.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.everyMessageHasACopyActionThat",
      "Every message has a Copy action that exports clean Markdown — handy for pasting an agent's reasoning into an issue or a PR description.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.selectARangeOfTheTranscriptAnd",
      "Select a range of the transcript and the context menu can export it as rich HTML — formatting intact when you paste it into an email.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.summaryModeRewritesTheStreamAsOne",
      "Summary mode rewrites the stream as one compact line per turn, so a very long session stays scannable.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.typeInThePromptToSearchThe",
      "Type `@` in the prompt to search the working directory and drop a real file path in — no copying paths out of the file tree.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.youCanReferenceAnotherConversationFromThe",
      "You can reference another conversation from the prompt, so an agent can be pointed at what a different session already figured out.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorHasAnOptionalVimMode",
      "The Editor has an optional vim mode and an auto-save toggle, so it can behave like the editor you already have muscle memory for.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.unsentDraftsAreSavedPerConversationSo",
      "Unsent drafts are saved per conversation, so switching features mid-sentence and coming back later picks up exactly where you stopped typing.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.mermaidDiagramsInAnAgentSMarkdown",
      "Mermaid diagrams in an agent's Markdown render as real diagrams inline — ask for a flowchart and you get a flowchart, not a code fence.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.excalidrawFilesOpenOnARealExcalidraw",
      "Excalidraw files open on a real Excalidraw canvas inside the Editor tab, so agent-drawn diagrams stay editable.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.enableGitBlameInSettingsAndThe",
      "Enable git blame in Settings and the Editor annotates the line under your cursor with its author, date, and commit summary as you move around.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.mergeConflictsOpenInADedicatedResolver",
      "Merge conflicts open in a dedicated resolver that lets you take either side or edit the merged result by hand, right inside Cadencr.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorHasAGoToLine",
      "The Editor has a go-to-line panel and per-file language overrides, for the times syntax detection guesses wrong on an unusual extension.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theEditorSplitsIntoMultiplePanesSo",
      "The Editor splits into multiple panes, so a test file and the implementation can sit side by side while the agent works.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.languageServersCanBeInstalledAndManaged",
      "Language servers can be installed and managed from Settings — the status indicator in the Editor tells you which ones are actually running.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.typeCheckerLinterAndFormatterAreConfigurable",
      "Type checker, linter, and formatter are configurable per project, and each one falls back to your global default when the project leaves it unset.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.turnOnFormatOnSaveAndThe",
      "Turn on format-on-save and the configured formatter runs on every save, so agent-written code lands already matching your project style.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.customModelsCanBeRegisteredByHand",
      "Custom models can be registered by hand, which is how self-hosted endpoints and proxies show up in the same picker as the built-in ones.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.starTheModelsYouUseMostAnd",
      "Star the models you use most and they float to the top of every model picker.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.cadencrDetectsTheAgentClisInstalledOn",
      "Cadencr detects the agent CLIs installed on your machine and shows the path and version of each one it found.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.desktopNotificationsCanFireWhenASession",
      "Desktop notifications can fire when a session finishes or needs an answer, so a long turn doesn't need babysitting.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.pairingARemoteDeviceIsAQr",
      "Pairing a remote device is a QR scan, and you choose the transport: your LAN when you’re on the same network, a tunnel when you’re not.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theGitTabManagesStashesEndTo",
      "The Git tab manages stashes end to end: create one from the current changes, then apply or drop it later without touching the terminal.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.filesCanBeStagedAndUnstagedIndividually",
      "Files can be staged and unstaged individually from the Git tab's file list, so you can split an agent's work into several focused commits.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.updateBranchPullsTheBaseBranchIn",
      "Update branch pulls the base branch in by rebase or merge, and a recovery banner walks you out of it if the operation stops on a conflict.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.pullRequestReviewThreadsAreAnnotatedStraight",
      "Pull request review threads are annotated straight onto the diff lines they were written about, so feedback and code stay together.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.pullRequestCommentsHaveTheirOwnFilterable",
      "Pull request comments have their own filterable view, which beats scrolling a web page to find the one thread that still needs an answer.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.connectGithubGitlabOrBitbucketInSettings",
      "Connect GitHub, GitLab, or Bitbucket in Settings → Git — or just opt into reusing the token from the `gh` / `glab` CLI you already authenticated.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.ifYouContinuedASessionInThe",
      "If you continued a session in the provider's own CLI, “Sync from CLI” in the session info popover pulls those events back into Cadencr.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theSessionInfoPopoverCopiesAReady",
      "The session info popover copies a ready-to-paste command that resumes the exact same conversation in the provider's terminal CLI.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.customActionsCanRunOnASchedule",
      "Custom actions can run on a schedule, so a nightly build, a lint sweep, or a dependency check happens without you starting it.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.whenOneSessionSpawnsAnotherTheSidebar",
      "When one session spawns another, the sidebar nests the child under its parent automatically — a spike and its follow-up stay together without any filing on your part.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.whenAnAgentCreatesAFeatureFor",
      "When an agent creates a feature for you, the message carries a badge that links straight back to the session that spawned it.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.theFileTreeIconSetIsSelectable",
      "The file tree icon set is selectable, and animations can be turned off entirely if you prefer a completely still interface.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.agentToDoListsRenderAsA",
      "Agent to-do lists render as a live checklist, so a long multi-step task shows what's done and what's still queued.",
    ),
  (t) =>
    t(
      "conversation.stream.sessionTips.subAgentsRenderNestedInsideTheParent",
      "Sub-agents render nested inside the parent turn, so you can follow what a spawned helper is doing without losing the main thread.",
    ),
] as const;
