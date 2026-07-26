/**
 * The schedule editor's prompt field: the real composer, not a textarea.
 *
 * A scheduled message is an ordinary prompt that happens to be sent later, so it
 * is written with the same editor and the same settings chips — `@` file
 * mentions, `@@` conversation references, and the provider's own `/` commands
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
import { ScheduleSettingsBar } from "./settings/ScheduleSettingsBar";
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

  return (
    <div className="flex flex-col gap-2">
      <ScheduleSettingsBar
        target={target}
        onChange={onTargetChange}
        runtime={runtime}
        projectPath={projectPath}
      />
      <div
        className="glass-surface flex max-h-48 min-h-0 items-start gap-1.5 rounded-lg border border-transparent bg-muted/40 py-3 pl-4 pr-2.5 transition-colors focus-within:bg-muted/55"
        onClick={handleSurfaceClick}
      >
        <PromptEditor
          ref={editorRef}
          initialText={initialPrompt}
          onChange={onPromptChange}
          placeholder="What should the agent do? (@ files, / commands)"
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
          promptCommandPolicy={{ ...catalog.policy, userShell: false }}
        />
      </div>
    </div>
  );
}
