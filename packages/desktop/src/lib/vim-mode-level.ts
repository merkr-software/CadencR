export const EDITOR_VIM_MODE_LEVEL_KEY = "editor_vim_mode_level";

export const VIM_MODE_LEVELS = ["0", "1", "2"] as const;

export type VimModeLevel = (typeof VIM_MODE_LEVELS)[number];

export const DEFAULT_VIM_MODE_LEVEL: VimModeLevel = "0";

export function parseVimModeLevel(value: string | null | undefined): VimModeLevel {
  return VIM_MODE_LEVELS.includes(value as VimModeLevel)
    ? (value as VimModeLevel)
    : DEFAULT_VIM_MODE_LEVEL;
}
