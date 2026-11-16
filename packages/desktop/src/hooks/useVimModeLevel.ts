import { useSetting } from "@/hooks/useSetting";
import {
  EDITOR_VIM_MODE_LEVEL_KEY,
  parseVimModeLevel,
  type VimModeLevel,
} from "@/lib/vim-mode-level";

/**
 * The active vim mode level, read consistently everywhere it matters:
 * `EditorPane` (CodeMirror vs. full Neovim) and the settings UI. Introduced
 * so both never disagree about what an unset or stale setting value means.
 */
export function useVimModeLevel(): VimModeLevel {
  const { value } = useSetting(EDITOR_VIM_MODE_LEVEL_KEY);
  return parseVimModeLevel(value);
}
