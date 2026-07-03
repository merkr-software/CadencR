import { useState, useMemo, useCallback } from "react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useFileSearch } from "@/api/generated";

interface FileMentionState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  triggerIndex: number;
}

const INITIAL_STATE: FileMentionState = {
  isOpen: false,
  query: "",
  selectedIndex: 0,
  triggerIndex: -1,
};

const DEBOUNCE_MS = 150;

interface UseFileMentionParams {
  projectId: number | undefined;
  featureId: number | undefined;
}

export function useFileMention({ projectId, featureId }: UseFileMentionParams) {
  const [state, setState] = useState<FileMentionState>(INITIAL_STATE);

  // Source of truth is the backend fuzzy search (same as the file picker), so
  // freshly created files are always reachable — no stale client-side list.
  // We only query while the mention popover is open.
  const debouncedQuery = useDebouncedValue(state.query, DEBOUNCE_MS);
  const { data } = useFileSearch(
    {
      project_id: projectId ?? 0,
      feature_id: featureId,
      query: debouncedQuery || undefined,
      include_dirs: true,
    },
    { query: { enabled: state.isOpen && projectId != null, keepPreviousData: true } },
  );

  const filteredItems = useMemo(() => {
    if (!state.isOpen) return [];
    // Directories carry a trailing slash so the inserted mention reads as a
    // folder (e.g. `@src/components/`).
    return (data?.files ?? []).map((f) => ({
      path: f.is_dir ? `${f.path}/` : f.path,
      isDir: f.is_dir,
    }));
  }, [state.isOpen, data]);

  const close = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const handleChange = useCallback(
    (newText: string, selectionStart: number) => {
      // Find the last unescaped @ before the cursor
      const textBeforeCursor = newText.slice(0, selectionStart);
      const atIndex = textBeforeCursor.lastIndexOf("@");

      if (atIndex === -1) {
        if (state.isOpen) close();
        return;
      }

      // @ must be at start or preceded by whitespace
      if (atIndex > 0 && !/\s/.test(newText[atIndex - 1])) {
        if (state.isOpen) close();
        return;
      }

      const query = textBeforeCursor.slice(atIndex + 1);

      // Close if there's a space in the query (user moved past the mention)
      if (query.includes(" ")) {
        if (state.isOpen) close();
        return;
      }

      setState({
        isOpen: true,
        query,
        selectedIndex: 0,
        triggerIndex: atIndex,
      });
    },
    [state.isOpen, close],
  );

  const confirm = useCallback(
    (text: string, selectedPath?: string): { newText: string; newCursorPos: number } | null => {
      if (!state.isOpen || filteredItems.length === 0) return null;
      const item = selectedPath
        ? filteredItems.find((i) => i.path === selectedPath)
        : filteredItems[state.selectedIndex];
      if (!item) return null;

      const before = text.slice(0, state.triggerIndex);
      const after = text.slice(state.triggerIndex + 1 + state.query.length);
      const insertion = `@${item.path}`;
      const newText = before + insertion + (after.startsWith(" ") ? after : " " + after);
      const newCursorPos = before.length + insertion.length + 1;

      close();
      return { newText, newCursorPos };
    },
    [state, filteredItems, close],
  );

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTextAreaElement>,
      text: string,
    ): { newText: string; newCursorPos: number } | true | false => {
      if (!state.isOpen || filteredItems.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setState((s) => ({
          ...s,
          selectedIndex: (s.selectedIndex + 1) % filteredItems.length,
        }));
        return true;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setState((s) => ({
          ...s,
          selectedIndex: (s.selectedIndex - 1 + filteredItems.length) % filteredItems.length,
        }));
        return true;
      }

      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const result = confirm(text);
        if (result) return result;
        return true;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }

      return false;
    },
    [state.isOpen, filteredItems, confirm, close],
  );

  return {
    isOpen: state.isOpen,
    query: state.query,
    selectedIndex: state.selectedIndex,
    filteredItems,
    handleChange,
    handleKeyDown,
    confirm,
    close,
  };
}
