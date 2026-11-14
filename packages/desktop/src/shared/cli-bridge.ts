/**
 * The `cadencr` command line's link with the desktop app.
 *
 * The CLI starts (or reaches, through the single-instance lock) the Electron
 * app with one `--cadencr-request=<json>` argument. Main validates it, brings
 * the window forward, and queues what the renderer must act on (open, add,
 * update) as `CliRendererItem`s, which the renderer drains.
 */

/** A request main hands to the renderer; `error` reports a request main refused. */
export type CliRendererItem =
  | {
      id: string;
      kind: "open";
      /** Absolute, canonical path the CLI resolved. */
      path: string;
      /** What main found at `path` when the request arrived. */
      pathKind: "file" | "directory";
      line?: number;
    }
  | { id: string; kind: "add"; path: string }
  /** `cadencr update`: run the "Check for updates" button's path. */
  | { id: string; kind: "update" }
  | { id: string; kind: "error"; message: string };

/** Where the `cadencr` command stands on this machine, for Settings. */
export type CliInstallStatus =
  /** No action can install it here (dev build, unofficial package, missing binary). */
  | { state: "unavailable"; reason: string }
  /** The DEB or RPM package put it on PATH at `path`. */
  | { state: "package"; path: string }
  | { state: "not-installed"; target: string; onPath: boolean }
  /** `current` is false when the installed command belongs to another copy of the app. */
  | { state: "installed"; target: string; onPath: boolean; current: boolean }
  /** Something that is not Cadencr's command already sits at `target`. */
  | { state: "conflict"; target: string; existing: string; onPath: boolean };

export interface CliInstallOptions {
  /** Replace a `conflict` target; only after the user confirmed it. */
  replace: boolean;
}
