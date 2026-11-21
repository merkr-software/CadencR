import type { WorkspaceTarget } from "./workspace-pool-state";

/**
 * Asking the workspace pool to mount a conversation before it is shown.
 *
 * Pressing a sidebar row is all but a promise to open it, and the press lasts
 * about as long as a workspace takes to mount. Mounting it hidden on the press
 * turns the click that follows into showing a mounted workspace. A request made
 * while no pool is mounted (another page is on screen) is dropped: the
 * conversation then mounts when it is opened, as it always could.
 */
type PrewarmListener = (target: WorkspaceTarget) => void;

const listeners = new Set<PrewarmListener>();

export function requestWorkspacePrewarm(target: WorkspaceTarget): void {
  for (const listener of listeners) listener(target);
}

export function subscribeWorkspacePrewarm(listener: PrewarmListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
