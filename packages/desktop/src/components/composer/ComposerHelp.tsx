import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { KBD_HINT_PROPS, KbdShortcut } from "@/components/KbdShortcut";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { ShortcutId } from "@/lib/shortcuts/registry";

/** A literal trigger, or a registry shortcut shown as currently bound (`twice`: pressed twice). */
type HelpKey = readonly string[] | { shortcut: ShortcutId; twice?: boolean };

/** `typed`: the row's trigger is characters any keyboard types, so it stays on touch. */
const ROWS: ReadonlyArray<readonly [string, HelpKey, (t: UiTranslator) => string, "typed"?]> = [
  [
    "file",
    ["@"],
    (t) => t("conversation.composer.composerHelp.file", "Attach a file or folder"),
    "typed",
  ],
  [
    "conversation",
    ["@@"],
    (t) => t("conversation.composer.composerHelp.conversation", "Reference another conversation"),
    "typed",
  ],
  [
    "command",
    ["/"],
    (t) => t("conversation.composer.composerHelp.command", "Commands and skills"),
    "typed",
  ],
  [
    "side",
    ["/cadencr:side"],
    (t) =>
      t(
        "conversation.composer.composerHelp.side",
        "Ask on the side — the agent is not interrupted",
      ),
    "typed",
  ],
  [
    "shell",
    ["!"],
    (t) => t("conversation.composer.composerHelp.shell", "Run a shell command yourself"),
    "typed",
  ],
  [
    "send",
    ["enter"],
    (t) => t("conversation.composer.composerHelp.send", "Send — or steer the agent while it works"),
  ],
  [
    "queue",
    { shortcut: "agent-send" },
    (t) => t("conversation.composer.composerHelp.queue", "Queue for after the agent's turn"),
  ],
  [
    "newline",
    ["shift", "enter"],
    (t) => t("conversation.composer.composerHelp.newline", "New line"),
  ],
  [
    "walk",
    ["up", "down"],
    (t) => t("conversation.composer.composerHelp.walk", "Walk your prompt history"),
  ],
  [
    "search",
    { shortcut: "prompt-history-search" },
    (t) => t("conversation.composer.composerHelp.search", "Search history and stashed drafts"),
  ],
  [
    "stash",
    { shortcut: "prompt-stash-draft" },
    (t) => t("conversation.composer.composerHelp.stash", "Stash the draft"),
  ],
  [
    "mode",
    { shortcut: "agent-permission-mode" },
    (t) => t("conversation.composer.composerHelp.mode", "Change the autonomy mode"),
  ],
  [
    "stop",
    { shortcut: "agent-stop", twice: true },
    (t) => t("conversation.composer.composerHelp.stop", "Stop the agent"),
  ],
  [
    "add",
    { shortcut: "editor-add-selection-to-prompt" },
    (t) =>
      t(
        "conversation.composer.composerHelp.add",
        "In the Editor or Terminal: add the selection here",
      ),
  ],
];

/**
 * The composer's grammar, one screen: what each trigger and key does. A touch
 * pointer keeps the typed triggers and drops the key rows (`data-kbd-hint`).
 */
export function ComposerHelp(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="p-3">
      <p className="mb-2 text-[13px] font-medium">
        {t("conversation.composer.composerHelp.composerKeysSyntax", "Composer keys & syntax")}
      </p>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-xs">
        {ROWS.map(([id, key, label, typed]) => (
          <div key={id} {...(typed ? undefined : KBD_HINT_PROPS)} className="contents">
            <dt>
              <HelpKeys value={key} typed={typed === "typed"} />
            </dt>
            <dd className="text-muted-foreground">{label(t)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HelpKeys({ value, typed }: { value: HelpKey; typed: boolean }): ReactElement {
  if ("shortcut" in value) return <BoundKeys {...value} />;
  return <KbdShortcut keys={[...value]} variant="hint" persistent={typed} />;
}

function BoundKeys({ shortcut, twice }: { shortcut: ShortcutId; twice?: boolean }): ReactElement {
  const keys = useShortcutKeys(shortcut);
  return (
    <span className="inline-flex items-center gap-1">
      <KbdShortcut keys={keys} variant="hint" />
      {twice && <KbdShortcut keys={keys} variant="hint" />}
    </span>
  );
}
