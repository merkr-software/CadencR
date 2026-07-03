import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, type EditorState, type LexicalEditor } from "lexical";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MentionNode } from "./nodes/MentionNode";
import { MentionPlugin } from "./plugins/MentionPlugin";
import { SlashCommandNode } from "./nodes/SlashCommandNode";
import { SlashCommandPlugin } from "./plugins/SlashCommandPlugin";
import { KeyboardShortcutsPlugin } from "./plugins/KeyboardShortcutsPlugin";
import { ImagePastePlugin } from "./plugins/ImagePastePlugin";
import { getEditorText, initializeEditorText, setEditorText } from "./editor-utils";
import type { SlashCommand } from "@/hooks/useSlashCommand";

export interface PromptEditorHandle {
  focus: () => void;
  clear: () => void;
  /** Set text. `moveSelection: false` populates without focusing the editor. */
  setText: (text: string, moveSelection?: boolean) => void;
  getText: () => string;
}

interface PromptEditorProps {
  onChange?: (text: string) => void;
  placeholder?: string;
  className?: string;
  /** Project/feature scope for the `@` file-mention backend search. */
  mentionProjectId?: number;
  mentionFeatureId?: number;
  slashCommands?: SlashCommand[];
  slashCommandsLoading?: boolean;
  /** Called when Enter pressed (no shift, no popover). Return true to consume. */
  onEnterSend?: () => boolean;
  /** Called on ArrowUp at the document start for prompt history. */
  onArrowUp?: () => string | null;
  /** Called on ArrowDown at the document end for prompt history. */
  onArrowDown?: () => string | null;
  disabled?: boolean;
  /** Initial text to populate the editor with (e.g. restored draft) */
  initialText?: string;
  /** Called when image files are pasted from the clipboard. */
  onPasteImages?: (files: File[]) => void;
}

function EditorRefPlugin({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  editorRef.current = editor;
  return null;
}

// NOTE: We intentionally do NOT ship a JS-driven autoresize plugin here.
//
// A `<div contenteditable="true">` grows to fit its content natively — unlike
// `<textarea>`. The wrapper passes `max-h-* min-h-* overflow-y-auto` via
// `className`, which gives the multi-line growth + cap + scroll behavior for
// free.
//
// A previous version registered an update listener that did:
//   el.style.height = "auto";
//   el.style.height = `${el.scrollHeight}px`;
// on every editor update. Reading `scrollHeight` forces the browser to do a
// synchronous full-document layout pass. With one tab visible that's
// borderline acceptable; with the splittable grid showing xterm + CodeMirror +
// AgentStream + diff viewer simultaneously it triggered cascading
// ResizeObserver callbacks (xterm refit, CodeMirror remeasure) on every
// keystroke and produced visible per-character lag in the prompt. The
// plugin's visual effect was already a no-op (max-height clamps the inline
// height anyway), so dropping it was pure performance win.

const PromptEditorInner = forwardRef<PromptEditorHandle, PromptEditorProps>(
  function PromptEditorInner(
    {
      onChange,
      placeholder,
      className,
      mentionProjectId,
      mentionFeatureId,
      slashCommands,
      slashCommandsLoading,
      onEnterSend,
      onArrowUp,
      onArrowDown,
      disabled,
      onPasteImages,
    },
    ref,
  ) {
    const editorRef = useRef<LexicalEditor | null>(null);

    useImperativeHandle(ref, () => ({
      focus() {
        editorRef.current?.focus();
      },
      clear() {
        editorRef.current?.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        });
      },
      setText(text: string, moveSelection = true) {
        if (editorRef.current) setEditorText(editorRef.current, text, moveSelection);
      },
      getText() {
        let text = "";
        editorRef.current?.getEditorState().read(() => {
          text = getEditorText();
        });
        return text;
      },
    }));

    const handleChange = useCallback(
      (_editorState: EditorState, editor: LexicalEditor) => {
        if (!onChange) return;
        editor.getEditorState().read(() => {
          onChange(getEditorText());
        });
      },
      [onChange],
    );

    return (
      <>
        <EditorRefPlugin editorRef={editorRef} />
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "w-full min-w-0 outline-none",
                disabled && "pointer-events-none opacity-50",
                className,
              )}
              aria-disabled={disabled}
            />
          }
          placeholder={
            placeholder ? (
              <div className="text-muted-foreground pointer-events-none absolute top-0 right-0 left-0 truncate select-none text-sm leading-[22px]">
                {placeholder}
              </div>
            ) : null
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <MentionPlugin projectId={mentionProjectId} featureId={mentionFeatureId} />
        <SlashCommandPlugin
          commands={slashCommands}
          isLoading={slashCommandsLoading}
          commandKind="command"
          triggerChar="/"
        />
        <SlashCommandPlugin
          commands={slashCommands}
          isLoading={slashCommandsLoading}
          commandKind="skill"
          triggerChar="$"
        />
        <KeyboardShortcutsPlugin
          onEnterSend={onEnterSend}
          onArrowUp={onArrowUp}
          onArrowDown={onArrowDown}
        />
        <ImagePastePlugin onPasteImages={onPasteImages} />
      </>
    );
  },
);

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(
  function PromptEditor(props, ref) {
    // `LexicalComposer` only reads `initialConfig` once on mount, but a fresh
    // object reference here would still re-create the closure (and the
    // `editorState` factory) on every parent render. Freezing it on mount
    // mirrors Lexical's semantics and keeps the composer's prop reference
    // stable. Note: changing `initialText` after mount is intentionally a
    // no-op — callers use `setText()` via the imperative handle to update the
    // editor at runtime (e.g. draft restore, history navigation).
    const initialTextRef = useRef(props.initialText);
    const initialConfig = useMemo(
      () => ({
        namespace: "PromptEditor",
        theme: { paragraph: "m-0 leading-[22px]" },
        nodes: [MentionNode, SlashCommandNode],
        onError(error: Error) {
          toast.error(`Editor error: ${error.message}`);
        },
        editorState: initialTextRef.current
          ? () => {
              initializeEditorText(initialTextRef.current!);
            }
          : undefined,
      }),
      [],
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative min-w-0 flex-1">
          <PromptEditorInner ref={ref} {...props} />
        </div>
      </LexicalComposer>
    );
  },
);
