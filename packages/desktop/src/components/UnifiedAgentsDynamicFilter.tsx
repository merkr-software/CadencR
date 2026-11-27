import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEventHandler,
  type ReactElement,
  type Ref,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND, type LexicalEditor } from "lexical";
import { HelpCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@/api/generated";
import {
  getUnifiedAgentsFilterSuggestions,
  type UnifiedAgentsFilterSuggestion,
} from "@/components/UnifiedAgentsFilterLanguage";
import { UnifiedAgentsFilterHelpDialog } from "@/components/UnifiedAgentsFilterHelpDialog";
import {
  getUnifiedAgentsFilterEditorText,
  initializeUnifiedAgentsFilterEditorText,
  replaceUnifiedAgentsFilterActiveToken,
  setUnifiedAgentsFilterEditorText,
} from "@/components/UnifiedAgentsFilterEditorText";
import { useUnifiedAgentsFilterShellFocus } from "@/components/UnifiedAgentsFilterFocus";
import { FilterEditorShell } from "@/components/UnifiedAgentsFilterEditorShell";
import { Button } from "@/components/ui/button";
import {
  UnifiedAgentsFilterSuggestionsMenu,
  useUnifiedAgentsFilterSuggestionKeyboard,
} from "@/components/UnifiedAgentsFilterSuggestions";
import { cn } from "@/lib/utils";

const FILTER_DEBOUNCE_MS = 300;

export interface UnifiedAgentsFilterInputHandle {
  focus: () => void;
  blur: () => void;
  /** Force the editor to display `text`, bypassing the dirty/focused guard
   *  that `useExternalFilterValue` applies. Used for programmatic filter
   *  changes (e.g. the per-card exclude button) so the box stays in sync. */
  setValue: (text: string) => void;
}

interface UnifiedAgentsDynamicFilterProps {
  value: string;
  projects: Project[];
  inputRef?: Ref<UnifiedAgentsFilterInputHandle>;
  onValueChange: (value: string) => void;
  onEnter?: () => void;
}

interface UnifiedAgentsFilterControlProps {
  editor: LexicalEditor;
  projects: Project[];
  draft: string;
  focused: boolean;
  suggestions: UnifiedAgentsFilterSuggestion[];
  selectedSuggestionIndex: number;
  onDraftChange: (value: string) => void;
  onFocusedChange: (focused: boolean) => void;
  onActiveTokenChange: (token: string | null) => void;
  onDirty: () => void;
  onClear: () => void;
  onApplySuggestion: (suggestion: UnifiedAgentsFilterSuggestion) => void;
  onShellMouseDown: MouseEventHandler<HTMLDivElement>;
}

function UnifiedAgentsFilterControl({
  editor,
  projects,
  draft,
  focused,
  suggestions,
  selectedSuggestionIndex,
  onDraftChange,
  onFocusedChange,
  onActiveTokenChange,
  onDirty,
  onClear,
  onApplySuggestion,
  onShellMouseDown,
}: UnifiedAgentsFilterControlProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="relative min-w-0 flex-1">
      <div
        className={cn(
          "titlebar-no-drag flex min-h-9 min-w-0 items-center gap-2 rounded-lg border border-border/80 bg-muted/40 px-2.5",
          "shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-[border-color,background-color,box-shadow]",
          "focus-within:border-primary/70 focus-within:bg-muted/55 focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.16),inset_0_1px_0_hsl(var(--foreground)/0.05)]",
        )}
        onMouseDown={onShellMouseDown}
      >
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <FilterEditorShell
          editor={editor}
          collapsed={!focused}
          onDraftChange={onDraftChange}
          onDirty={onDirty}
          onFocusChange={onFocusedChange}
          onActiveSlashFilterTokenChange={onActiveTokenChange}
        />
        <UnifiedAgentsFilterHelpDialog projects={projects}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 rounded text-muted-foreground hover:text-foreground"
            aria-label={t(
              "agents.unifiedAgentsDynamicFilter.explainAgentFilterLanguage",
              "Explain agent filter language",
            )}
          >
            <HelpCircleIcon className="size-3" />
          </Button>
        </UnifiedAgentsFilterHelpDialog>
        {draft.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 rounded text-muted-foreground hover:text-foreground"
            onClick={onClear}
            aria-label={t(
              "agents.unifiedAgentsDynamicFilter.clearAgentFilter",
              "Clear agent filter",
            )}
          >
            <XIcon className="size-3" />
          </Button>
        )}
      </div>
      {suggestions.length > 0 ? (
        <UnifiedAgentsFilterSuggestionsMenu
          suggestions={suggestions}
          selectedIndex={selectedSuggestionIndex}
          onApply={onApplySuggestion}
        />
      ) : null}
    </div>
  );
}

export const UnifiedAgentsDynamicFilter = memo(function UnifiedAgentsDynamicFilter({
  value,
  projects,
  inputRef,
  onValueChange,
  onEnter,
}: UnifiedAgentsDynamicFilterProps): ReactElement {
  const initialValueRef = useRef(value);
  const initialConfig = useMemo(
    () => ({
      namespace: "UnifiedAgentsDynamicFilter",
      theme: { paragraph: "m-0" },
      onError(error: Error) {
        toast.error(
          translateUi("agents.filter.editorError", "Filter editor error: {{message}}", {
            message: error.message,
          }),
        );
      },
      editorState: () => initializeUnifiedAgentsFilterEditorText(initialValueRef.current),
    }),
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <UnifiedAgentsDynamicFilterInner
        value={value}
        projects={projects}
        inputRef={inputRef}
        onValueChange={onValueChange}
        onEnter={onEnter}
      />
    </LexicalComposer>
  );
});

function UnifiedAgentsDynamicFilterInner({
  value,
  projects,
  inputRef,
  onValueChange,
  onEnter,
}: UnifiedAgentsDynamicFilterProps): ReactElement {
  const { t } = useUiTranslation();
  const [editor] = useLexicalComposerContext();
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const dirtyRef = useRef(false);
  const skipNextDirtyRef = useRef(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [activeSlashFilterToken, setActiveSlashFilterToken] = useState<string | null>(null);
  const suggestions = useMemo(
    () =>
      activeSlashFilterToken
        ? getUnifiedAgentsFilterSuggestions(activeSlashFilterToken, projects, t)
        : [],
    [activeSlashFilterToken, projects, t],
  );

  const applyExternalValue = useCallback(
    (text: string): void => {
      dirtyRef.current = false;
      setDraft(text);
      setUnifiedAgentsFilterEditorText(editor, text, { selection: "none" });
    },
    [editor],
  );
  useFilterImperativeHandle(inputRef, editor, applyExternalValue);
  useExternalFilterValue(value, editor, focused, dirtyRef, setDraft);
  useDebouncedFilterCommit(draft, onValueChange, dirtyRef);
  useEffect(() => {
    setSelectedSuggestionIndex(0);
    setDismissedDraft(null);
  }, [draft]);

  const applySuggestion = useCallback(
    (suggestion: UnifiedAgentsFilterSuggestion): void => {
      const keyOnlySuggestion = suggestion.replacement.endsWith(":");
      if (keyOnlySuggestion) skipNextDirtyRef.current = true;
      const nextDraft = replaceUnifiedAgentsFilterActiveToken(editor, suggestion.replacement);
      if (!nextDraft) return;
      setDraft(nextDraft);
      if (keyOnlySuggestion) return;
      dirtyRef.current = false;
      onValueChange(nextDraft);
    },
    [editor, onValueChange],
  );

  const visibleSuggestions =
    focused && activeSlashFilterToken !== null && dismissedDraft !== draft ? suggestions : [];
  useFilterSubmission(editor, onValueChange, onEnter, dirtyRef, setDraft);
  useUnifiedAgentsFilterSuggestionKeyboard({
    editor,
    enabled: focused,
    projects,
    suggestions: visibleSuggestions,
    selectedIndex: selectedSuggestionIndex,
    setSelectedSuggestionIndex,
    onApply: applySuggestion,
    onDismiss: () => setDismissedDraft(draft),
  });

  const handleShellMouseDown = useUnifiedAgentsFilterShellFocus(editor);
  const clearFilter = useCallback((): void => {
    dirtyRef.current = false;
    setDraft("");
    setUnifiedAgentsFilterEditorText(editor, "");
    onValueChange("");
  }, [editor, onValueChange]);

  return (
    <UnifiedAgentsFilterControl
      editor={editor}
      projects={projects}
      draft={draft}
      focused={focused}
      suggestions={visibleSuggestions}
      selectedSuggestionIndex={selectedSuggestionIndex}
      onDraftChange={setDraft}
      onFocusedChange={setFocused}
      onActiveTokenChange={setActiveSlashFilterToken}
      onDirty={() => {
        if (skipNextDirtyRef.current) {
          skipNextDirtyRef.current = false;
          return;
        }
        dirtyRef.current = true;
      }}
      onClear={clearFilter}
      onApplySuggestion={applySuggestion}
      onShellMouseDown={handleShellMouseDown}
    />
  );
}

function useFilterImperativeHandle(
  inputRef: Ref<UnifiedAgentsFilterInputHandle> | undefined,
  editor: LexicalEditor,
  setValue: (text: string) => void,
): void {
  useImperativeHandle(inputRef, () => ({
    focus() {
      editor.focus();
      editor.update(() => {
        $getRoot().selectEnd();
      });
    },
    blur() {
      editor.blur();
      editor.getRootElement()?.blur();
    },
    setValue(text: string) {
      setValue(text);
    },
  }));
}

function useExternalFilterValue(
  value: string,
  editor: LexicalEditor,
  focused: boolean,
  dirtyRef: MutableRefObject<boolean>,
  setDraft: (value: string) => void,
): void {
  useEffect((): void => {
    if (focused || dirtyRef.current) return;
    setDraft(value);
    setUnifiedAgentsFilterEditorText(editor, value, { selection: "none" });
  }, [dirtyRef, editor, focused, setDraft, value]);
}

function useFilterEnterCommand(editor: LexicalEditor, onEnter: (value: string) => void): void {
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null): boolean => {
          event?.preventDefault();
          editor.getEditorState().read(() => onEnter(getUnifiedAgentsFilterEditorText()));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, onEnter],
  );
}

function useFilterSubmission(
  editor: LexicalEditor,
  onValueChange: (value: string) => void,
  onEnter: (() => void) | undefined,
  dirtyRef: MutableRefObject<boolean>,
  setDraft: (value: string) => void,
): void {
  const handleEnter = useCallback(
    (nextDraft: string): void => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) activeElement.blur();
      editor.blur();
      editor.getRootElement()?.blur();
      dirtyRef.current = false;
      setDraft(nextDraft);
      onValueChange(nextDraft);
      onEnter?.();
    },
    [dirtyRef, editor, onEnter, onValueChange, setDraft],
  );
  useFilterEnterCommand(editor, handleEnter);
}

function useDebouncedFilterCommit(
  draft: string,
  onValueChange: (value: string) => void,
  dirtyRef: MutableRefObject<boolean>,
): void {
  useEffect((): (() => void) | void => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      dirtyRef.current = false;
      onValueChange(draft);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, dirtyRef, onValueChange]);
}
