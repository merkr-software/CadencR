/**
 * The schedule editor's prompt field: the real composer, not a textarea.
 *
 * A scheduled message is an ordinary prompt that happens to be sent later, so it
 * is written in the same composer card — the same editor and instruments: `@`
 * file mentions, `@@` conversation references, and the provider's own `/` commands
 * and `$` skills, resolved for the project the run will happen in. Writing it in
 * a bare textarea meant learning a second, weaker way to write a prompt, and
 * left the runtime options stranded in unrelated dropdowns.
 *
 * Two things the session composer has are deliberately absent: attachments,
 * which a schedule has nowhere to store, and the `!` shell prefix, which only
 * means anything on a live session's own shell channel — dispatch would send it
 * to the agent as literal text.
 */
import { useCallback, useRef, type ReactElement } from "react";
import { PromptEditor, type PromptEditorHandle } from "@/components/prompt-editor/PromptEditor";
import type { ScheduleTarget } from "@/api/generated";
import { shouldFocusPromptFromSurfaceClick } from "@/components/agent-prompt-focus";
import { usePromptCommands } from "@/hooks/usePromptCommands";
import { ScheduleInstruments } from "./settings/ScheduleInstruments";
import { ScheduleLaunchManifest } from "./settings/ScheduleLaunchManifest";
import { useScheduleRuntime } from "./settings/useScheduleRuntime";

export interface ScheduleComposerProps {
  /** Initial text. The editor is uncontrolled after mount — remount (via the
   *  dialog's form key) to load a different schedule's prompt. */
  initialPrompt: string;
  onPromptChange: (prompt: string) => void;
  target: ScheduleTarget;
  onTargetChange: (next: ScheduleTarget) => void;
  /** Path of the target project. Doubles as the working directory the command
   *  and skill catalog is resolved in — both live in the repo. */
  projectPath?: string;
}

export function ScheduleComposer({
  initialPrompt,
  onPromptChange,
  target,
  onTargetChange,
  projectPath,
}: ScheduleComposerProps): ReactElement {
  const editorRef = useRef<PromptEditorHandle>(null);
  const handleSurfaceClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (!shouldFocusPromptFromSurfaceClick(event.target)) return;
    editorRef.current?.focus();
  }, []);

  // Which commands exist depends on the agent the run will use, so the catalog
  // follows the model chip rather than the app's default provider.
  const runtime = useScheduleRuntime(target);
  const catalog = usePromptCommands(projectPath, runtime.providerId);

  // The session composer's card: launch line (where each run works), the
  // editor, then the instrument row. `data-composer-card` also anchors the
  // editor's `@` and `/` menus to the card, as in a conversation.
  return (
    <div
      data-composer-card
      className="glass-surface flex max-h-72 min-h-0 flex-col rounded-lg border border-transparent bg-muted/40 transition-colors focus-within:bg-muted/55"
      onClick={handleSurfaceClick}
    >
      {/* An existing conversation already has a working copy; only a schedule
          that creates one gets to choose. */}
      {target.kind === "new_conversation" && (
        <ScheduleLaunchManifest
          target={target}
          onChange={onTargetChange}
          projectPath={projectPath}
        />
      )}
      <div className="flex min-h-0 flex-1 items-start gap-1.5 px-4 pt-3.5 pb-2">
        <PromptEditor
          ref={editorRef}
          initialText={initialPrompt}
          onChange={onPromptChange}
          placeholder="Describe the task — @ for files, / for commands"
          className="min-h-16 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-sm leading-[22px] shadow-none focus:border-0 focus:ring-0"
          mentionProjectId={target.project_id ?? undefined}
          mentionFeatureId={target.feature_id ?? undefined}
          slashCommands={catalog.commands}
          // The catalog request can't even start until the target resolves to a
          // provider, and until then `usePromptCommands` is disabled — so it
          // reports "not loading" while holding an empty list. Typing `/` in
          // that window would show an empty menu as if the provider genuinely
          // had no commands, so the resolve counts as part of the load.
          slashCommandsLoading={runtime.isResolving || catalog.isLoading}
          slashCommandsError={catalog.error}
          promptCommandPolicy={{ ...catalog.policy, userShell: false }}
        />
      </div>
      <ScheduleInstruments target={target} onChange={onTargetChange} runtime={runtime} />
    </div>
  );
}
