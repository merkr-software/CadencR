import type { Shortcut } from "./types";

export const AGENT_SHORTCUTS = [
  // ─── Agent & prompt ──────────────────────────────────────────────────
  {
    id: "agent-model-picker",
    keys: ["mod", "p"],
    describe(t) {
      return t("shortcuts.descriptions.agent-model-picker", "Open model picker");
    },
    scope: "agent",
  },
  {
    id: "agent-thinking",
    keys: ["mod", "t"],
    describe(t) {
      return t("shortcuts.descriptions.agent-thinking", "Cycle thinking effort");
    },
    scope: "agent",
  },
  {
    // ⌘F / Ctrl+F — find-in-conversation. Bound capture-phase in the `agent`
    // scope so it intercepts before the prompt editor; the editor tab keeps
    // its own ⌘F ("Find in current file") because that's a different scope.
    id: "conversation-search",
    keys: ["mod", "f"],
    describe(t) {
      return t("shortcuts.descriptions.conversation-search", "Find in conversation");
    },
    scope: "agent",
    aliases: ["search", "find"],
  },
  {
    id: "agent-send",
    keys: ["mod", "enter"],
    describe(t) {
      return t(
        "shortcuts.descriptions.agent-send",
        "Send message (queue it while the agent works)",
      );
    },
    scope: "agent",
  },
  {
    id: "agent-maximize",
    keys: ["mod", "shift", "enter"],
    describe(t) {
      return t("shortcuts.descriptions.agent-maximize", "Maximize agent");
    },
    scope: "agent",
  },
  {
    id: "agent-collapse",
    keys: ["mod", "shift", "z"],
    describe(t) {
      return t("shortcuts.descriptions.agent-collapse", "Collapse agent");
    },
    scope: "agent",
  },
  {
    id: "agent-permission-mode",
    keys: ["shift", "tab"],
    describe(t) {
      return t("shortcuts.descriptions.agent-permission-mode", "Cycle permission mode");
    },
    scope: "agent",
  },
  {
    // Free in this scope: ⌘⇧C is only the Editor tab's "Copy file path".
    // Toggles: from the prompt into the wizard, and from the wizard back.
    id: "agent-skill-wizard",
    keys: ["mod", "shift", "c"],
    describe(t) {
      return t(
        "shortcuts.descriptions.agent-skill-wizard",
        "Configure the invoked /cadencr skill, or return to the prompt",
      );
    },
    scope: "agent",
    aliases: ["skill", "wizard"],
  },
  {
    id: "agent-autoscroll",
    keys: ["mod", "shift", "s"],
    describe(t) {
      return t("shortcuts.descriptions.agent-autoscroll", "Re-enable auto-scroll");
    },
    scope: "agent",
  },
  {
    id: "agent-previous-message",
    keys: ["alt", "up"],
    describe(t) {
      return t("shortcuts.descriptions.agent-previous-message", "Jump to your previous message");
    },
    scope: "agent",
    aliases: ["navigator", "prompt"],
  },
  {
    id: "agent-next-message",
    keys: ["alt", "down"],
    describe(t) {
      return t("shortcuts.descriptions.agent-next-message", "Jump to your next message");
    },
    scope: "agent",
    aliases: ["navigator", "prompt"],
  },
  {
    id: "agent-use-referenced-worktree",
    keys: ["mod", "shift", "w"],
    describe(t) {
      return t(
        "shortcuts.descriptions.agent-use-referenced-worktree",
        "Reuse referenced conversation worktree",
      );
    },
    scope: "agent",
  },
  {
    // ⌘⌥W. The other W chords are taken — ⌘W closes the window, ⌘⇧W is
    // `agent-use-referenced-worktree` right above, which can be live at the
    // same time in this same scope.
    //
    // Bare ⌥W is deliberately avoided: Option alone composes a character, so
    // macOS reports `event.key` as "∑" (QWERTY) or "≈" (AZERTY, where the
    // labelled W sits on `KeyZ`). With no un-mangled key and no usable code,
    // the AZERTY case can't be matched at all. Holding Cmd suppresses the
    // composition, so `event.key` stays "w" on every layout.
    //
    // Off macOS `mod` is Control, making this Ctrl+Alt+W — the AltGr chord.
    // Accepted because no common layout assigns AltGr+W a character, but it
    // rules out `mod+alt` for any letter that layouts do use there (E, 2, 7…).
    id: "agent-worktree-mode",
    keys: ["mod", "alt", "w"],
    describe(t) {
      return t("shortcuts.descriptions.agent-worktree-mode", "Cycle branch / worktree behavior");
    },
    scope: "agent",
    aliases: ["worktree", "branch"],
  },
  {
    // Literal Control on every platform, like a shell's reverse search.
    id: "prompt-history-search",
    keys: ["ctrl", "r"],
    describe(t) {
      return t(
        "shortcuts.descriptions.prompt-history-search",
        "Search prompt history and stashed drafts",
      );
    },
    scope: "agent",
    aliases: ["history", "recall"],
  },
  {
    id: "prompt-stash-draft",
    keys: ["ctrl", "s"],
    describe(t) {
      return t(
        "shortcuts.descriptions.prompt-stash-draft",
        "Stash the draft (bring it back from history search)",
      );
    },
    scope: "agent",
    aliases: ["stash", "draft"],
  },
  {
    // Two presses: the first arms stop and shows a hint, the second (within
    // `STOP_ARM_WINDOW_MS`) stops. A lone Esc only ever closes/backs out.
    id: "agent-stop",
    keys: ["escape"],
    describe(t) {
      return t("shortcuts.descriptions.agent-stop", "Stop running agent (press twice)");
    },
    scope: "agent",
  },

  // ─── Plan approval ───────────────────────────────────────────────────
  {
    id: "plan-approve",
    keys: ["mod", "y"],
    describe(t) {
      return t("shortcuts.descriptions.plan-approve", "Approve plan");
    },
    scope: "plan-approval",
  },
  {
    id: "plan-feedback",
    keys: ["mod", "n"],
    describe(t) {
      return t("shortcuts.descriptions.plan-feedback", "Request plan changes (feedback)");
    },
    scope: "plan-approval",
  },
  {
    id: "plan-reject",
    keys: ["escape"],
    describe(t) {
      return t("shortcuts.descriptions.plan-reject", "Reject plan");
    },
    scope: "plan-approval",
  },

  // ─── Tool permission prompt ──────────────────────────────────────────
  {
    id: "perm-allow-once",
    keys: ["mod", "y"],
    describe(t) {
      return t("shortcuts.descriptions.perm-allow-once", "Allow once");
    },
    scope: "permission-prompt",
  },
  {
    id: "perm-allow-future",
    keys: ["mod", "l"],
    describe(t) {
      return t("shortcuts.descriptions.perm-allow-future", "Allow for the rest of session");
    },
    scope: "permission-prompt",
  },
  {
    id: "perm-deny",
    keys: ["mod", "n"],
    describe(t) {
      return t("shortcuts.descriptions.perm-deny", "Deny");
    },
    scope: "permission-prompt",
  },

  // ─── Question drawer ─────────────────────────────────────────────────
  {
    id: "q-select-1-9",
    keys: ["1-9"],
    describe(t) {
      return t("shortcuts.descriptions.q-select-1-9", "Select option");
    },
    scope: "question-drawer",
  },
  {
    id: "q-other",
    keys: ["mod", "o"],
    describe(t) {
      return t("shortcuts.descriptions.q-other", 'Toggle "Other…"');
    },
    scope: "question-drawer",
  },
  {
    id: "q-submit",
    keys: ["enter"],
    describe(t) {
      return t("shortcuts.descriptions.q-submit", "Submit / next question");
    },
    scope: "question-drawer",
  },
  {
    id: "q-prev",
    keys: ["left"],
    describe(t) {
      return t("shortcuts.descriptions.q-prev", "Previous question");
    },
    scope: "question-drawer",
  },
  {
    id: "q-next",
    keys: ["right"],
    describe(t) {
      return t("shortcuts.descriptions.q-next", "Next question");
    },
    scope: "question-drawer",
  },
] as const satisfies readonly Shortcut[];
