/**
 * Why the renderer is asked to confirm a close. Quitting stops the service and
 * every agent with it; closing the last window on macOS does not: the app,
 * and its agents, keep running in the Dock.
 */
export interface AppCloseRequest {
  id: number;
  quitting: boolean;
}
