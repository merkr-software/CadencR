import { useEffect, type ReactElement } from "react";
import {
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from "lexical";
import type { Project } from "@/api/generated";
import {
  getUnifiedAgentsFilterSuggestions,
  type UnifiedAgentsFilterSuggestion,
} from "@/components/UnifiedAgentsFilterLanguage";
import { getUnifiedAgentsFilterActiveToken } from "@/components/UnifiedAgentsFilterEditorText";
import { ProjectBadge } from "@/components/ProjectBadge";
import { cn } from "@/lib/utils";

interface SuggestionsMenuProps {
  suggestions: UnifiedAgentsFilterSuggestion[];
  selectedIndex: number;
  onApply: (suggestion: UnifiedAgentsFilterSuggestion) => void;
}

interface SuggestionKeyboardArgs extends SuggestionsMenuProps {
  editor: LexicalEditor;
  enabled: boolean;
  projects: Project[];
  setSelectedSuggestionIndex: (index: number) => void;
  onDismiss: () => void;
}

export function UnifiedAgentsFilterSuggestionsMenu({
  suggestions,
  selectedIndex,
  onApply,
}: SuggestionsMenuProps): ReactElement {
  return (
    <div className="glass-surface absolute top-full left-0 z-20 mt-1 w-full overflow-hidden rounded-lg border border-border/80 bg-popover shadow-xl">
      {suggestions.map((suggestion: UnifiedAgentsFilterSuggestion, index: number) => (
        <SuggestionRow
          key={`${suggestion.label}-${suggestion.detail}`}
          suggestion={suggestion}
          selected={index === selectedIndex}
          onApply={onApply}
        />
      ))}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  onApply,
}: {
  suggestion: UnifiedAgentsFilterSuggestion;
  selected: boolean;
  onApply: (suggestion: UnifiedAgentsFilterSuggestion) => void;
}): ReactElement {
  return (
    <button
      type="button"
      data-selected={selected}
      className={cn(
        "group flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2 text-left text-xs",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-popover-foreground hover:bg-accent/70",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        onApply(suggestion);
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        {suggestion.projectId ? <ProjectBadge projectId={suggestion.projectId} /> : null}
        <span className="truncate font-mono text-foreground group-data-[selected=true]:text-accent-foreground">
          {suggestion.label}
        </span>
      </span>
      <span className="min-w-0 shrink truncate text-muted-foreground group-hover:text-foreground/80 group-data-[selected=true]:text-accent-foreground/80">
        {suggestion.detail}
      </span>
    </button>
  );
}

export function useUnifiedAgentsFilterSuggestionKeyboard({
  editor,
  enabled,
  projects,
  suggestions,
  selectedIndex,
  setSelectedSuggestionIndex,
  onApply,
  onDismiss,
}: SuggestionKeyboardArgs): void {
  useEffect((): (() => void) | void => {
    if (!enabled) return;
    const commands = [
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event): boolean =>
          moveSuggestionSelection(event, suggestions, selectedIndex, 1, setSelectedSuggestionIndex),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event): boolean =>
          moveSuggestionSelection(
            event,
            suggestions,
            selectedIndex,
            -1,
            setSelectedSuggestionIndex,
          ),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event): boolean =>
          applyCurrentSuggestion(
            editor,
            projects,
            suggestions,
            selectedIndex,
            event,
            onApply,
            true,
          ),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event): boolean =>
          applyCurrentSuggestion(
            editor,
            projects,
            suggestions,
            selectedIndex,
            event,
            onApply,
            false,
          ),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event): boolean => {
          if (suggestions.length === 0) return false;
          event?.preventDefault();
          onDismiss();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => commands.forEach((unregister: () => void): void => unregister());
  }, [
    editor,
    enabled,
    onApply,
    onDismiss,
    projects,
    selectedIndex,
    setSelectedSuggestionIndex,
    suggestions,
  ]);
}

function moveSuggestionSelection(
  event: KeyboardEvent | null,
  suggestions: UnifiedAgentsFilterSuggestion[],
  selectedIndex: number,
  delta: number,
  setSelectedSuggestionIndex: (index: number) => void,
): boolean {
  if (suggestions.length === 0) return false;
  event?.preventDefault();
  const nextIndex = (selectedIndex + delta + suggestions.length) % suggestions.length;
  setSelectedSuggestionIndex(nextIndex);
  return true;
}

function applyCurrentSuggestion(
  editor: LexicalEditor,
  projects: Project[],
  visibleSuggestions: UnifiedAgentsFilterSuggestion[],
  selectedIndex: number,
  event: KeyboardEvent | null,
  onApply: (suggestion: UnifiedAgentsFilterSuggestion) => void,
  allowHiddenFallback: boolean,
): boolean {
  const currentSuggestions = allowHiddenFallback
    ? getCurrentSuggestions(editor, projects, visibleSuggestions)
    : visibleSuggestions;
  if (currentSuggestions.length === 0) return false;
  event?.preventDefault();
  const suggestion = currentSuggestions[Math.min(selectedIndex, currentSuggestions.length - 1)];
  if (!suggestion) return false;
  onApply(suggestion);
  return true;
}

function getCurrentSuggestions(
  editor: LexicalEditor,
  projects: Project[],
  visibleSuggestions: UnifiedAgentsFilterSuggestion[],
): UnifiedAgentsFilterSuggestion[] {
  if (visibleSuggestions.length > 0) return visibleSuggestions;
  let activeToken: string | null = null;
  editor.getEditorState().read(() => {
    activeToken = getUnifiedAgentsFilterActiveToken()?.text ?? null;
  });
  return activeToken ? getUnifiedAgentsFilterSuggestions(activeToken, projects) : [];
}
