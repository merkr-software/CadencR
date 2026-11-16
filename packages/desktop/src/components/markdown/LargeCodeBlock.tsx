import { memo, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { Virtuoso, type ItemContent } from "react-virtuoso";
import { CodeBlockShell } from "@/components/CodeBlockShell";

export const LARGE_CODE_LINE_THRESHOLD = 400;
export const LARGE_CODE_CHARACTER_THRESHOLD = 32 * 1024;
const MAX_VISIBLE_LINE_CHARACTERS = 2_000;
const LARGE_CODE_HEIGHT = 384;
const INITIAL_VISIBLE_LINES = 20;
const APPEND_CHECK_CHARACTERS = 64;

interface LargeCodeBlockProps {
  language: string;
  code: string;
  isStreaming?: boolean;
  showTerminalButton: boolean;
  onSendToTerminal?: (command: string) => void;
  icon?: ReactNode;
  leadingActions?: ReactNode;
}

interface CodeLineIndex {
  code: string;
  starts: number[];
}

interface LargeCodeContext {
  lineIndex: CodeLineIndex;
}

export function isLargeCodeBlock(code: string): boolean {
  if (code.length >= LARGE_CODE_CHARACTER_THRESHOLD) return true;
  let lines = 1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10 && ++lines >= LARGE_CODE_LINE_THRESHOLD) return true;
  }
  return false;
}

function createLineIndex(code: string): CodeLineIndex {
  const starts = [0];
  appendLineStarts(starts, code, 0);
  return { code, starts };
}

function updateLineIndex(
  previous: CodeLineIndex,
  code: string,
  isStreaming: boolean,
): CodeLineIndex {
  if (previous.code === code) return previous;
  if (!isStreaming || !hasAppendBoundary(previous.code, code)) return createLineIndex(code);
  appendLineStarts(previous.starts, code, previous.code.length);
  previous.code = code;
  return previous;
}

function appendLineStarts(starts: number[], code: string, from: number): void {
  for (let index = from; index < code.length; index += 1) {
    if (code.charCodeAt(index) === 10) starts.push(index + 1);
  }
}

function hasAppendBoundary(previous: string, next: string): boolean {
  if (next.length < previous.length) return false;
  const headEnd = Math.min(previous.length, APPEND_CHECK_CHARACTERS);
  const tailStart = Math.max(headEnd, previous.length - APPEND_CHECK_CHARACTERS);
  return (
    next.slice(0, headEnd) === previous.slice(0, headEnd) &&
    next.slice(tailStart, previous.length) === previous.slice(tailStart)
  );
}

function visibleLine(line: string): string {
  if (line.length <= MAX_VISIBLE_LINE_CHARACTERS) return line;
  return `${line.slice(0, MAX_VISIBLE_LINE_CHARACTERS)}… [${line.length - MAX_VISIBLE_LINE_CHARACTERS} more characters]`;
}

const renderLine: ItemContent<unknown, LargeCodeContext> = (index, _data, context) => {
  const { code, starts } = context.lineIndex;
  const start = starts[index] ?? code.length;
  const next = starts[index + 1];
  const end = next === undefined ? code.length : next - 1;
  return (
    <div
      data-large-code-line={index + 1}
      className="min-w-max whitespace-pre px-3 font-mono text-xs leading-5"
    >
      {visibleLine(code.slice(start, end)) || "\u00a0"}
    </div>
  );
};

function LargeCodeBlockImpl({
  language,
  code,
  isStreaming = false,
  showTerminalButton,
  onSendToTerminal,
  icon,
  leadingActions,
}: LargeCodeBlockProps): ReactElement {
  const lineIndexRef = useRef<CodeLineIndex | null>(null);
  const lineIndex = lineIndexRef.current
    ? updateLineIndex(lineIndexRef.current, code, isStreaming)
    : createLineIndex(code);
  lineIndexRef.current = lineIndex;
  const context = useMemo<LargeCodeContext>(() => ({ lineIndex }), [code, lineIndex]);

  return (
    <CodeBlockShell
      language={language}
      icon={icon}
      code={code}
      showTerminalButton={showTerminalButton}
      onSendToTerminal={onSendToTerminal}
      leadingActions={leadingActions}
    >
      <p className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
        Large code — virtualized for performance. Very long lines are shortened visually; Copy
        includes all content.
      </p>
      <Virtuoso
        context={context}
        totalCount={lineIndex.starts.length}
        fixedItemHeight={20}
        initialItemCount={INITIAL_VISIBLE_LINES}
        increaseViewportBy={80}
        itemContent={renderLine}
        style={{ height: LARGE_CODE_HEIGHT }}
        className="overflow-x-auto py-2"
        role="region"
        aria-label={`${language} code, ${lineIndex.starts.length} lines`}
        tabIndex={0}
      />
    </CodeBlockShell>
  );
}

export const LargeCodeBlock = memo(LargeCodeBlockImpl);
