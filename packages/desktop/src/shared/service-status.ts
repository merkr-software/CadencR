/**
 * The packaged service as Electron's main process supervises it. `down` means
 * it exited while the app still needed it; the window offers a restart.
 */
export type ServiceStatus =
  | { state: "running" }
  | { state: "restarting" }
  | { state: "down"; detail: string };
