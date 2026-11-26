import type { AppCloseRequest } from "../../src/shared/app-close";

/** How long the window gets to show its confirmation before main closes anyway. */
export const CLOSE_RESPONSE_TIMEOUT_MS = 5_000;

/**
 * Whether closing the main window quits the app. Only macOS keeps the app,
 * and so its agents, running in the Dock without a window; closing the last
 * window quits everywhere else.
 */
export function windowCloseQuits(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

export interface CloseRenderer {
  /** Whether a live, responsive renderer is there to answer. */
  canAnswer: () => boolean;
  /** Ask it to confirm; false when the message could not be delivered. */
  ask: (request: AppCloseRequest) => boolean;
}

interface CloseTimers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface CloseCoordinatorOptions {
  renderer: CloseRenderer;
  /** Carry out a close that is settled: confirmed, or decided by main. */
  finish: (request: AppCloseRequest) => Promise<void> | void;
  /** Main closed without the window's answer, and why. */
  reportUnanswered: (request: AppCloseRequest, reason: string) => void;
  responseTimeoutMs?: number;
  timers?: CloseTimers;
}

export interface CloseCoordinator {
  /** A close or quit was requested (window button, ⌘Q, ⌘W, the Dock, the menu). */
  request: (quitting: boolean) => void;
  /** The window received the request and is asking the user. */
  acknowledge: (id: number) => void;
  /** The user kept the app open. */
  cancel: (id?: number) => void;
  /** The user confirmed the close waiting on them. */
  confirm: (id: number) => Promise<void> | void;
  /** The renderer crashed or hung: nobody can answer a waiting close. */
  rendererLost: () => void;
  /** The renderer reloaded: its confirmation, if any, is gone with the page. */
  rendererReset: () => void;
}

const defaultTimers: CloseTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The one owner of "a close is waiting on the user". The renderer only shows
 * the confirmation and answers; whether the answer closes the window or quits
 * is what main recorded when it asked. A renderer that cannot answer (gone,
 * crashed, hung, silent past the timeout) never blocks a quit. Main carries
 * out the original request with the same policy as a confirmed close.
 */
export function createCloseCoordinator(options: CloseCoordinatorOptions): CloseCoordinator {
  const timers = options.timers ?? defaultTimers;
  const timeoutMs = options.responseTimeoutMs ?? CLOSE_RESPONSE_TIMEOUT_MS;
  let pending: AppCloseRequest | null = null;
  let nextId = 0;
  let timer: unknown = null;

  const stopTimer = (): void => {
    if (timer === null) return;
    timers.clear(timer);
    timer = null;
  };
  const settle = (): AppCloseRequest | null => {
    const request = pending;
    pending = null;
    stopTimer();
    return request;
  };
  const closeUnanswered = (reason: string): void => {
    const request = settle();
    if (!request) return;
    options.reportUnanswered(request, reason);
    void options.finish(request);
  };

  return {
    request: (quitting) => {
      if (pending && (pending.quitting || !quitting)) return;
      stopTimer();
      const request: AppCloseRequest = { id: ++nextId, quitting };
      pending = request;
      if (!options.renderer.canAnswer() || !options.renderer.ask(request)) {
        closeUnanswered("the window is not available");
        return;
      }
      timer = timers.set(() => {
        timer = null;
        closeUnanswered(`the window did not answer within ${timeoutMs} ms`);
      }, timeoutMs);
    },
    acknowledge: (id) => {
      if (pending?.id === id) stopTimer();
    },
    cancel: (id) => {
      if (id === undefined || pending?.id === id) settle();
    },
    confirm: (id) => {
      if (pending?.id !== id) return;
      const request = settle();
      if (request) return options.finish(request);
    },
    rendererLost: () => closeUnanswered("the window stopped responding"),
    rendererReset: () => {
      if (pending?.quitting) closeUnanswered("the window reloaded");
      else settle();
    },
  };
}
