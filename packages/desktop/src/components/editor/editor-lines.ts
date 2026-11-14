import { EditorView } from "@codemirror/view";

export function clampEditorLineNumber(lineNumber: number, lineCount: number): number {
  return Math.min(Math.max(1, lineNumber), Math.max(1, lineCount));
}

export function scrollToEditorLine(view: EditorView, lineNumber: number, column = 1): void {
  const target = clampEditorLineNumber(lineNumber, view.state.doc.lines);
  const line = view.state.doc.line(target);
  const position = line.from + Math.min(Math.max(0, column - 1), line.length);
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
  });
}
