// The project tree auto-expands the active project whenever `activeProjectId`
// changes, so any navigation to a conversation reveals its parent project.
// Opening a conversation from the pinned section must not do that: the marker
// below names the one project whose auto-expand is suppressed. It is keyed to
// that project and is not consumed on read (StrictMode double-invokes effects,
// so a consume-once getter would expand on the second pass); it is cleared as
// soon as the active project changes to a different one, so a later navigation
// to the same project expands it normally.
let skippedProjectId: number | null = null;

export function skipProjectAutoExpand(projectId: number): void {
  skippedProjectId = projectId;
}

export function shouldSkipProjectAutoExpand(projectId: number): boolean {
  return skippedProjectId === projectId;
}

export function clearProjectAutoExpandSkip(): void {
  skippedProjectId = null;
}
