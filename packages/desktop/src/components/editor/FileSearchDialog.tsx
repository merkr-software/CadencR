import { useEffect, useState, type ReactNode } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { useFileSearch, type FileMatchResult } from "@/api/generated";
import { useEditorState } from "@/hooks/useEditorState";
import { useOpenFileInNeovim } from "./neovim/useOpenFileInNeovim";
import { FileSymbolIcon } from "./file-icons";

interface FileSearchDialogProps {
  projectId: number;
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEBOUNCE_MS = 150;

export default function FileSearchDialog({
  projectId,
  featureId,
  open,
  onOpenChange,
}: FileSearchDialogProps) {
  const { activePaneId, openFile } = useEditorState(featureId);
  // Defined only when the editor pane is actually showing Neovim, which owns
  // its own buffers — opening a tab in the store would be invisible there.
  // Mirrors the file tree, the other entry point into "open this file".
  const openInNeovim = useOpenFileInNeovim(featureId);
  const { value: maxTabsSetting } = useDebouncedSetting("editor_max_tabs");
  const maxTabs = parseInt(maxTabsSetting ?? "10", 10);

  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebouncedValue(searchQuery, DEBOUNCE_MS);

  const { data, isLoading } = useFileSearch(
    { project_id: projectId, feature_id: featureId, query: debouncedQuery || undefined },
    { query: { enabled: open, placeholderData: keepPreviousData } },
  );

  // Reset search when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery("");
    }
  }, [open]);

  function handleSelect(filePath: string) {
    if (openInNeovim) openInNeovim(filePath);
    else openFile(activePaneId ?? "main", filePath, maxTabs);
    onOpenChange(false);
  }

  const files = data?.files ?? [];
  const firstPath = files[0]?.path ?? "";
  const [selectedValue, setSelectedValue] = useState("");

  // Select first result whenever results change
  useEffect(() => {
    setSelectedValue(firstPath);
  }, [firstPath]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      commandProps={{ shouldFilter: false, value: selectedValue, onValueChange: setSelectedValue }}
    >
      <CommandInput
        placeholder="Search files..."
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList>
        {isLoading && files.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
        )}
        {!isLoading && files.length === 0 && <CommandEmpty>No files found.</CommandEmpty>}
        {files.map((file) => (
          <FileResultItem key={file.path} file={file} onSelect={handleSelect} />
        ))}
      </CommandList>
    </CommandDialog>
  );
}

interface FileResultItemProps {
  file: FileMatchResult;
  onSelect: (filePath: string) => void;
}

function FileResultItem({ file, onSelect }: FileResultItemProps) {
  const { path: filePath, positions } = file;
  const lastSlash = filePath.lastIndexOf("/");
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const fileNameOffset = lastSlash >= 0 ? lastSlash + 1 : 0;
  return (
    <CommandItem value={filePath} onSelect={() => onSelect(filePath)}>
      <FileSymbolIcon fileName={fileName} className="mr-2 shrink-0 flex items-center" />
      <div className="flex flex-col min-w-0">
        <span className="truncate">{highlightMatches(fileName, positions, fileNameOffset)}</span>
        <span className="text-xs text-muted-foreground truncate">
          {highlightMatches(filePath, positions, 0)}
        </span>
      </div>
    </CommandItem>
  );
}

function highlightMatches(text: string, positions: number[], offset: number): ReactNode {
  if (positions.length === 0) return text;

  const posSet = new Set(positions.map((p) => p - offset));
  const parts: ReactNode[] = [];
  let run = "";
  let runHighlighted = false;

  for (let i = 0; i < text.length; i++) {
    const isMatch = posSet.has(i);
    if (isMatch !== runHighlighted && run) {
      parts.push(
        runHighlighted ? (
          <mark key={parts.length} className="bg-transparent text-primary font-semibold">
            {run}
          </mark>
        ) : (
          run
        ),
      );
      run = "";
    }
    run += text[i];
    runHighlighted = isMatch;
  }

  if (run) {
    parts.push(
      runHighlighted ? (
        <mark key={parts.length} className="bg-transparent text-primary font-semibold">
          {run}
        </mark>
      ) : (
        run
      ),
    );
  }

  return parts;
}
