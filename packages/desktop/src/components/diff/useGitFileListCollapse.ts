import { useCallback, useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";

const GIT_SIDEBAR_COLLAPSED_SETTING = "git_sidebar_collapsed";

interface UseGitFileListCollapseOptions {
  controlledValue?: boolean;
  onControlledChange?: (collapsed: boolean) => void;
}

export interface GitFileListCollapseState {
  collapsed: boolean;
  showCollapsedRail: boolean;
  isControlled: boolean;
  isLoading: boolean;
  setCollapsed: (collapsed: boolean) => void;
  collapse: () => void;
}

export function useGitFileListCollapse({
  controlledValue,
  onControlledChange,
}: UseGitFileListCollapseOptions): GitFileListCollapseState {
  const isControlled = controlledValue !== undefined;
  const { value, setValue, isLoading } = useSetting(GIT_SIDEBAR_COLLAPSED_SETTING);
  const collapsed = isControlled ? Boolean(controlledValue) : value === "true";
  const showCollapsedRail = isControlled ? collapsed : isLoading || collapsed;
  const setCollapsed = useCallback(
    (next: boolean): void => {
      if (isControlled) onControlledChange?.(next);
      else setValue(String(next));
    },
    [isControlled, onControlledChange, setValue],
  );
  const collapse = useCallback((): void => setCollapsed(true), [setCollapsed]);

  return useMemo(
    () => ({ collapsed, showCollapsedRail, isControlled, isLoading, setCollapsed, collapse }),
    [collapse, collapsed, isControlled, isLoading, setCollapsed, showCollapsedRail],
  );
}
