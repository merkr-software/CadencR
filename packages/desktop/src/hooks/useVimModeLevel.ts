import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  EDITOR_VIM_MODE_LEVEL_KEY,
  parseVimModeLevel,
  type VimModeLevel,
} from "@/lib/vim-mode-level";

/**
 * CodeMirror's Vim motions and the legacy full-Neovim selection.
 * An explicit editor_backend takes precedence over the legacy level.
 */
export function useVimModeLevel(): VimModeLevel {
  const { value } = useDebouncedSetting(EDITOR_VIM_MODE_LEVEL_KEY);
  return parseVimModeLevel(value);
}
