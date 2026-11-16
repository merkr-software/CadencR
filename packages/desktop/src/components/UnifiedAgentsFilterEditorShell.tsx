import { useCallback, type ReactElement } from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import type { EditorState, LexicalEditor } from "lexical";
import {
  FilterTextNodeNormalizationPlugin,
  PlainSpaceAfterFilterTokenPlugin,
  SlashFilterCursorPlugin,
} from "@/components/UnifiedAgentsFilterPlugins";
import { KbdShortcut } from "@/components/KbdShortcut";
import { getUnifiedAgentsFilterEditorText } from "@/components/UnifiedAgentsFilterEditorText";
import { cn } from "@/lib/utils";

interface FilterEditorShellProps {
  editor: LexicalEditor;
  collapsed: boolean;
  onDraftChange: (value: string) => void;
  onDirty: () => void;
  onFocusChange: (focused: boolean) => void;
  onActiveSlashFilterTokenChange: (token: string | null) => void;
}

export function FilterEditorShell({
  editor,
  collapsed,
  onDraftChange,
  onDirty,
  onFocusChange,
  onActiveSlashFilterTokenChange,
}: FilterEditorShellProps): ReactElement {
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
              // Unfocused: keep the box a single line, ellipsizing a long filter.
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
          <div className="pointer-events-none absolute top-1/2 right-16 left-8 -translate-y-1/2 truncate select-none text-[12.5px] leading-5 text-muted-foreground">
            Filter agents by name · type{" "}
            <span className="text-foreground/70">
              <KbdShortcut keys={["/"]} variant="inline-sm" />
            </span>{" "}
            for project, time, sort…
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
