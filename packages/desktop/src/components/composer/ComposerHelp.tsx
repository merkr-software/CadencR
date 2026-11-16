import type { ReactElement } from "react";
import { KbdShortcut } from "@/components/KbdShortcut";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { ShortcutId } from "@/lib/shortcuts/registry";

/** A literal trigger, or a registry shortcut shown as currently bound (`twice`: pressed twice). */
type HelpKey = readonly string[] | { shortcut: ShortcutId; twice?: boolean };

const ROWS: ReadonlyArray<readonly [string, HelpKey, string]> = [
  ["file", ["@"], "Attach a file or folder"],
  ["conversation", ["@@"], "Reference another conversation"],
  ["command", ["/"], "Commands and skills"],
  ["side", ["/cadencr:side"], "Ask on the side — the agent is not interrupted"],
  ["shell", ["!"], "Run a shell command yourself"],
  ["send", ["enter"], "Send — or steer the agent while it works"],
  ["queue", { shortcut: "agent-send" }, "Queue for after the agent's turn"],
  ["newline", ["shift", "enter"], "New line"],
  ["walk", ["up", "down"], "Walk your prompt history"],
  ["search", { shortcut: "prompt-history-search" }, "Search history and stashed drafts"],
  ["stash", { shortcut: "prompt-stash-draft" }, "Stash the draft"],
  ["mode", { shortcut: "agent-permission-mode" }, "Change the autonomy mode"],
  ["stop", { shortcut: "agent-stop", twice: true }, "Stop the agent"],
  [
    "add",
    { shortcut: "editor-add-selection-to-prompt" },
    "In the Editor or Terminal: add the selection here",
  ],
];

/** The composer's grammar, one screen: what each trigger and key does. */
export function ComposerHelp(): ReactElement {
  return (
    <div className="p-3">
      <p className="mb-2 text-[13px] font-medium">Composer keys & syntax</p>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-xs">
        {ROWS.map(([id, key, label]) => (
          <div key={id} className="contents">
            <dt>
              <HelpKeys value={key} />
            </dt>
            <dd className="text-muted-foreground">{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HelpKeys({ value }: { value: HelpKey }): ReactElement {
  if ("shortcut" in value) return <BoundKeys {...value} />;
  return <KbdShortcut keys={[...value]} variant="hint" />;
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
