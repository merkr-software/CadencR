import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
  type Ref,
} from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $getRoot,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { HelpCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@/api/generated";
import {
  getUnifiedAgentsFilterSuggestions,
  type UnifiedAgentsFilterSuggestion,
} from "@/components/UnifiedAgentsFilterLanguage";
import { UnifiedAgentsFilterHelpDialog } from "@/components/UnifiedAgentsFilterHelpDialog";
import {
  FilterTextNodeNormalizationPlugin,
  PlainSpaceAfterFilterTokenPlugin,
  SlashFilterCursorPlugin,
} from "@/components/UnifiedAgentsFilterPlugins";
import {
  getUnifiedAgentsFilterEditorText,
  initializeUnifiedAgentsFilterEditorText,
  replaceUnifiedAgentsFilterActiveToken,
  setUnifiedAgentsFilterEditorText,
} from "@/components/UnifiedAgentsFilterEditorText";
import { useUnifiedAgentsFilterShellFocus } from "@/components/UnifiedAgentsFilterFocus";
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
        toast.error(`Filter editor error: ${error.message}`);
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
        ? getUnifiedAgentsFilterSuggestions(activeSlashFilterToken, projects)
        : [],
    [activeSlashFilterToken, projects],
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
    [editor, onEnter, onValueChange],
  );
  useFilterEnterCommand(editor, handleEnter);
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
    <div className="relative min-w-0 flex-1">
      <div
        className={cn(
          "titlebar-no-drag flex min-h-9 min-w-0 items-center gap-2 rounded-lg border border-border/80 bg-muted/40 px-2.5",
          "shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-[border-color,background-color,box-shadow]",
          "focus-within:border-primary/70 focus-within:bg-muted/55 focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.16),inset_0_1px_0_hsl(var(--foreground)/0.05)]",
        )}
        onMouseDown={handleShellMouseDown}
      >
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <FilterEditorShell
          editor={editor}
          collapsed={!focused}
          onDraftChange={setDraft}
          onDirty={() => {
            if (skipNextDirtyRef.current) {
              skipNextDirtyRef.current = false;
              return;
            }
            dirtyRef.current = true;
          }}
          onFocusChange={setFocused}
          onActiveSlashFilterTokenChange={setActiveSlashFilterToken}
        />
        <UnifiedAgentsFilterHelpDialog projects={projects}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 rounded text-muted-foreground hover:text-foreground"
            aria-label="Explain agent filter language"
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
            onClick={clearFilter}
            aria-label="Clear agent filter"
          >
            <XIcon className="size-3" />
          </Button>
        )}
      </div>
      {visibleSuggestions.length > 0 ? (
        <UnifiedAgentsFilterSuggestionsMenu
          suggestions={visibleSuggestions}
          selectedIndex={selectedSuggestionIndex}
          onApply={applySuggestion}
        />
      ) : null}
    </div>
  );
}

function FilterEditorShell({
  editor,
  collapsed,
  onDraftChange,
  onDirty,
  onFocusChange,
  onActiveSlashFilterTokenChange,
}: {
  editor: LexicalEditor;
  collapsed: boolean;
  onDraftChange: (value: string) => void;
  onDirty: () => void;
  onFocusChange: (focused: boolean) => void;
  onActiveSlashFilterTokenChange: (token: string | null) => void;
}): ReactElement {
  const handleChange = useCallback(
    (_editorState: EditorState): void => {
      editor.getEditorState().read(() => {
        onDirty();
        onDraftChange(getUnifiedAgentsFilterEditorText());
      });
    },
    [editor, onDirty, onDraftChange],
  );

  return (
    <>
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className={cn(
              "min-h-8 min-w-0 flex-1 py-1.5 font-mono text-[12.5px] leading-5 text-foreground outline-none",
              // Unfocused: keep the box a single line, ellipsizing a long filter
              // (the `[&>p]` target hits the Lexical paragraph that holds the
              // tokens). Focused: let it wrap so the whole filter stays editable.
              collapsed
                ? "overflow-hidden whitespace-nowrap [&>p]:overflow-hidden [&>p]:text-ellipsis [&>p]:whitespace-nowrap"
                : "whitespace-pre-wrap break-words",
            )}
            aria-label="Filter agents"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
          />
        }
        placeholder={
          <div className="pointer-events-none absolute top-1/2 left-7 -translate-y-1/2 select-none font-mono text-[12.5px] leading-5 text-muted-foreground">
            Filter by agent name… type / for last, project, sort, exclude, pin
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
      <SlashFilterCursorPlugin onTokenChange={onActiveSlashFilterTokenChange} />
      <FilterTextNodeNormalizationPlugin />
      <PlainSpaceAfterFilterTokenPlugin />
    </>
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
