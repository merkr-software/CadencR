import { memo } from "react";
import { ClipboardCopyIcon, FileTextIcon, FolderOpenIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";
import { copyToClipboard } from "@/lib/clipboard";
import { displayGitTreePath } from "@/lib/git-display-path";
import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import type { FileGroupData } from "./contentSearchGroups";
import { FileSymbolIcon } from "./file-icons";
import SearchResultEditor from "./SearchResultEditor";

export const ContentSearchFileGroup = memo(function ContentSearchFileGroup({
  group,
  onSelect,
}: {
  group: FileGroupData;
  onSelect: (filePath: string, lineNumber?: number) => void;
}) {
  const { t } = useUiTranslation();
  const fileName = group.path.split("/").pop() ?? group.path;
  const firstMatchLine = group.matches[0]?.line_number ?? 1;

  return (
    <div className="pb-3">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onSelect(group.path, firstMatchLine)}
            className="flex items-center gap-1.5 px-2 py-1 w-full text-left text-xs font-medium text-foreground hover:bg-accent rounded transition-colors"
          >
            <FileSymbolIcon fileName={fileName} className="shrink-0 flex items-center" />
            <span className="truncate">{displayGitTreePath(group.path)}</span>
            <span className="ml-auto text-muted-foreground shrink-0">{group.matches.length}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuActionItem
            icon={FolderOpenIcon}
            onSelect={() => onSelect(group.path, firstMatchLine)}
          >
            {t("search.content.open", "Open")}
          </ContextMenuActionItem>
          <ContextMenuActionItem
            icon={ClipboardCopyIcon}
            onSelect={() =>
              void copyToClipboard(
                group.path,
                translateUi("palette.actions.pathCopied", "Path copied"),
              )
            }
          >
            {t("search.content.copyPath", "Copy Path")}
          </ContextMenuActionItem>
          <ContextMenuActionItem
            icon={FileTextIcon}
            onSelect={() =>
              void copyToClipboard(
                group.matches[0]?.line_content ?? "",
                translateUi("search.content.matchCopied", "Match copied"),
              )
            }
          >
            {t("search.content.copyMatch", "Copy Match")}
          </ContextMenuActionItem>
        </ContextMenuContent>
      </ContextMenu>
      <div className="mt-1">
        <SearchResultEditor
          filePath={group.path}
          matches={group.matches}
          onClick={(lineNumber) => onSelect(group.path, lineNumber)}
        />
      </div>
    </div>
  );
});
