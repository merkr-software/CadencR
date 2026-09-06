/** Focus the real input owned by this feature's terminal renderer. */
export function focusNeovimEditor(featureId: number): boolean {
  const host = document.querySelector<HTMLElement>(`[data-neovim-feature-id="${featureId}"]`);
  const target = host?.querySelector<HTMLElement>("textarea") ?? host;
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}
