import { createContext, useContext, type ReactElement, type ReactNode } from "react";

export type OpenDiffInEditor = (filePath: string, lineNumber?: number) => void;

const OpenDiffInEditorContext = createContext<OpenDiffInEditor | undefined>(undefined);

export function OpenDiffInEditorProvider({
  children,
  onOpenFileInEditor,
}: {
  children: ReactNode;
  onOpenFileInEditor: OpenDiffInEditor;
}): ReactElement {
  return (
    <OpenDiffInEditorContext.Provider value={onOpenFileInEditor}>
      {children}
    </OpenDiffInEditorContext.Provider>
  );
}

export function useOpenDiffInEditor(): OpenDiffInEditor | undefined {
  return useContext(OpenDiffInEditorContext);
}
