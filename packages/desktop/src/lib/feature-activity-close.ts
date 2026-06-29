/**
 * Noun describing a feature's live activity (running terminals and/or open
 * browser tabs) for the sidebar "Close …" action. Shared by the context-menu
 * item and the toast wording so they always agree. Callers must only invoke it
 * when at least one count is positive.
 */
export function closeFeatureActivityNoun(shellCount: number, browserCount: number): string {
  const hasShells = shellCount > 0;
  const hasBrowsers = browserCount > 0;
  if (hasShells && hasBrowsers) return "terminals & browsers";
  if (hasShells) return shellCount === 1 ? "terminal" : "terminals";
  return browserCount === 1 ? "browser tab" : "browser tabs";
}
