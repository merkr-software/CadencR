import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MentionNode } from "./nodes/MentionNode";
import { MentionPlugin } from "./plugins/MentionPlugin";
import { SlashCommandNode } from "./nodes/SlashCommandNode";
import { SlashCommandPlugin } from "./plugins/SlashCommandPlugin";
import { KeyboardShortcutsPlugin } from "./plugins/KeyboardShortcutsPlugin";
import { ImagePastePlugin } from "./plugins/ImagePastePlugin";
import { LongPastePlugin } from "./plugins/LongPastePlugin";
import { ConversationReferencePlugin } from "./plugins/ConversationReferencePlugin";
import { ConversationReferenceNode } from "./nodes/ConversationReferenceNode";
import { $isShellCommandPrefixNode, ShellCommandPrefixNode } from "./nodes/ShellCommandPrefixNode";
import { ShellCommandPlugin, type ShellCommandEditorState } from "./plugins/ShellCommandPlugin";
import { getEditorText, initializeEditorText, setEditorText } from "./editor-utils";
import type { SlashCommand } from "@/lib/slash-command";
import {
  DEFAULT_PROMPT_COMMAND_POLICY,
  promptCommandTriggers,
  type PromptCommandPolicy,
} from "@/lib/prompt-command-policy";

export interface PromptEditorHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  /** Set text. `moveSelection: false` populates without focusing the editor. */
  setText: (text: string, moveSelection?: boolean) => void;
  getText: () => string;
  /** Insert text at the caret (or at the end when the editor has no selection). */
  insertText: (text: string) => void;
  /** Exit shell mode while preserving the command text. */
  clearShellCommandMode: () => void;
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
  /** Why the provider's own commands could not be listed, shown in the `/` menu. */
  slashCommandsError?: string | null;
  promptCommandPolicy?: PromptCommandPolicy;
  /** Called when Enter pressed (no shift, no popover). Return true to consume. */
  onEnterSend?: () => boolean;
  /** Called on ⌘/Ctrl+Enter (queue while the agent works). Return true to consume. */
  onModEnterSend?: () => boolean;
  /** Called on ArrowUp at the document start for prompt history. */
  onArrowUp?: () => string | null;
  /** Called on ArrowDown at the document end for prompt history. */
  onArrowDown?: () => string | null;
  /** True while an untouched history entry is shown (see KeyboardShortcutsPlugin). */
  isBrowsingHistory?: () => boolean;
  disabled?: boolean;
  /** Initial text to populate the editor with (e.g. restored draft) */
  initialText?: string;
  /** Called when image files are pasted from the clipboard. */
  onPasteImages?: (files: File[]) => void;
  /** Called instead of inserting a very long text paste (see `LongPastePlugin`). */
  onPasteLongText?: (text: string) => void;
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

/**
 * A disabled editor must also refuse typing: `pointer-events-none` does not
 * stop a focused editor, and text typed during an awaited send is never saved
 * as a draft. Layout effect, so a refocus scheduled for the next frame lands
 * on an editable root again. Handles changes only; the mount value is in
 * `initialConfig`.
 */
function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();
  useLayoutEffect(() => editor.setEditable(editable), [editor, editable]);
  return null;
}

function removeShellCommandPrefix(): void {
  const root = $getRoot();
  const firstParagraph = root.getFirstChild();
  const firstNode = $isElementNode(firstParagraph) ? firstParagraph.getFirstChild() : null;
  if ($isShellCommandPrefixNode(firstNode)) {
    firstNode.remove();
  } else if ($isTextNode(firstNode) && firstNode.getTextContent().startsWith("!")) {
    firstNode.setTextContent(firstNode.getTextContent().slice(1));
  } else {
    return;
  }
  root.selectEnd();
}

function usePromptEditorHandle(
  ref: React.ForwardedRef<PromptEditorHandle>,
  editorRef: React.MutableRefObject<LexicalEditor | null>,
  shellCommandsEnabled: boolean,
): void {
  useImperativeHandle(ref, () => ({
    focus() {
      editorRef.current?.focus();
    },
    blur() {
      // Clear Lexical's selection so a pending update cannot refocus the editor.
      editorRef.current?.update(() => $setSelection(null));
      editorRef.current?.blur();
    },
    clear() {
      editorRef.current?.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
    },
    setText(text: string, moveSelection = true) {
      if (editorRef.current) {
        setEditorText(editorRef.current, text, moveSelection, shellCommandsEnabled);
      }
    },
    getText() {
      let text = "";
      editorRef.current?.getEditorState().read(() => {
        text = getEditorText();
      });
      return text;
    },
    insertText(text: string) {
      editorRef.current?.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(text);
          return;
        }
        const root = $getRoot();
        root.selectEnd();
        $getSelection()?.insertText(text);
      });
    },
    clearShellCommandMode() {
      editorRef.current?.update(removeShellCommandPrefix);
    },
  }));
}

function ShellCommandPlaceholder() {
  return (
    <div className="pointer-events-none absolute top-0 right-0 left-0 truncate font-mono text-sm leading-[22px] text-muted-foreground select-none max-[767px]:text-base">
      Type a shell command…
    </div>
  );
}

function editableClassName(
  shell: ShellCommandEditorState,
  disabled: boolean | undefined,
  className: string | undefined,
): string {
  return cn(
    "w-full min-w-0 outline-none",
    shell.active && "font-mono",
    // Bare `!` stays a real (transparent) text node so Lexical keeps a caret
    // target, but pull it left by one character so the caret (and the hidden `!`)
    // rest at the line start beside the placeholder rather than one character in.
    shell.empty && "text-transparent caret-primary [&_[data-lexical-text]]:-ml-[1ch]",
    disabled && "pointer-events-none opacity-50",
    className,
  );
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
      slashCommandsError,
      promptCommandPolicy = DEFAULT_PROMPT_COMMAND_POLICY,
      onEnterSend,
      onModEnterSend,
      onArrowUp,
      onArrowDown,
      isBrowsingHistory,
      disabled,
      onPasteImages,
      onPasteLongText,
    },
    ref,
  ) {
    const editorRef = useRef<LexicalEditor | null>(null);
    const [shellCommandState, setShellCommandState] = useState<ShellCommandEditorState>({
      active: false,
      empty: false,
    });
    usePromptEditorHandle(ref, editorRef, promptCommandPolicy.userShell);

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
        <EditablePlugin editable={!disabled} />
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={editableClassName(shellCommandState, disabled, className)}
              // Shell commands are not prose — suppress the red spellcheck squiggle.
              spellCheck={!shellCommandState.active}
              aria-disabled={disabled}
              aria-label="Message to the agent"
              aria-multiline
            />
          }
          placeholder={
            placeholder ? (
              <div className="text-muted-foreground pointer-events-none absolute top-0 right-0 left-0 truncate select-none text-sm leading-[22px] max-[767px]:text-base">
                {placeholder}
              </div>
            ) : null
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        {shellCommandState.empty && <ShellCommandPlaceholder />}
        <HistoryPlugin />
        <ShellCommandPlugin
          enabled={promptCommandPolicy.userShell}
          onStateChange={setShellCommandState}
        />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        {!shellCommandState.active && (
          <>
            <MentionPlugin projectId={mentionProjectId} featureId={mentionFeatureId} />
            <ConversationReferencePlugin currentFeatureId={mentionFeatureId} />
            {promptCommandTriggers(promptCommandPolicy).map((trigger) => (
              <SlashCommandPlugin
                key={`${trigger.triggerChar}:${trigger.commandKindsAtPromptStart.join(",")}:${trigger.commandKindsMidPrompt.join(",")}`}
                commands={slashCommands}
                isLoading={slashCommandsLoading}
                error={slashCommandsError}
                commandKindsAtPromptStart={trigger.commandKindsAtPromptStart}
                commandKindsMidPrompt={trigger.commandKindsMidPrompt}
                triggerChar={trigger.triggerChar}
              />
            ))}
          </>
        )}
        <KeyboardShortcutsPlugin
          onEnterSend={onEnterSend}
          onModEnterSend={onModEnterSend}
          onArrowUp={onArrowUp}
          onArrowDown={onArrowDown}
          isBrowsingHistory={isBrowsingHistory}
          shellCommandsEnabled={promptCommandPolicy.userShell}
        />
        {!shellCommandState.active && <ImagePastePlugin onPasteImages={onPasteImages} />}
        {!shellCommandState.active && <LongPastePlugin onPasteLongText={onPasteLongText} />}
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
    const initialShellCommandsEnabledRef = useRef(
      props.promptCommandPolicy?.userShell ?? DEFAULT_PROMPT_COMMAND_POLICY.userShell,
    );
    // `LexicalComposer` sets editability on mount after its children's
    // effects, so the mount value has to come from the config.
    const initialEditableRef = useRef(!props.disabled);
    const initialConfig = useMemo(
      () => ({
        namespace: "PromptEditor",
        editable: initialEditableRef.current,
        theme: { paragraph: "m-0 leading-[22px]" },
        nodes: [MentionNode, SlashCommandNode, ConversationReferenceNode, ShellCommandPrefixNode],
        onError(error: Error) {
          toast.error(`Editor error: ${error.message}`);
        },
        editorState: initialTextRef.current
          ? () => {
              initializeEditorText(initialTextRef.current!, initialShellCommandsEnabledRef.current);
            }
          : undefined,
      }),
      [],
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        {/* This wrapper — not the editable — is the flex item of the prompt
            surface, so the height budget has to land here and be handed down.
            `self-stretch` takes the surface's height (which the surface caps
            and can shrink), `flex-col` + the editable's `flex-1 min-h-0` pass
            it to the editable, which scrolls. All used values, no percentage
            heights: those need a definite ancestor to resolve against, and
            WebKit resolves them differently from Blink inside a flex column.
            Keep the scroll on the editable, not here — `data-prompt-editor-anchor`
            lets slash menus fix-position to this box and escape composer overflow. */}
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col self-stretch"
          data-prompt-editor-anchor
        >
          <PromptEditorInner ref={ref} {...props} />
        </div>
      </LexicalComposer>
    );
  },
);
