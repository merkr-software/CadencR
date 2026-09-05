import { createContext, useContext, type ReactElement, type ReactNode } from "react";

// A conflicted file drops into the resolver automatically on open (see
// `useAutoConflictResolution`), so opening a diff file needs no resolver flag.
export type OpenDiffInEditor = (filePath: string, lineNumber?: number, column?: number) => void;

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
