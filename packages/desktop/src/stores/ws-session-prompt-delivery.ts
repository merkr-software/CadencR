/**
 * Delivery promises for prompts that could not leave immediately: queued
 * before `session.initialized` (keyed by `messageUuid`), or parked in the
 * outbound queue while the socket is down (keyed by envelope id).
 *
 * A composer that awaits the delivery promise keeps its pending state
 * until the prompt is on the wire, and gets it back when initialization fails
 * or the session is torn down first (issue #251). Promise callbacks are not
 * render state, so they live here rather than in the zustand entry.
 */

interface DeliveryWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export const SESSION_CLOSED_BEFORE_DELIVERY = "The session closed before the message was sent.";

/** One session's delivery promises, owned by its store's transport registry. */
export function createPromptDeliveryTracker() {
  const waiters = new Map<string, DeliveryWaiter>();
  return {
    await(key: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        waiters.set(key, { resolve, reject });
      });
    },
    /** Resolve the waiters of prompts that just reached the wire. */
    settle(keys: readonly string[]): void {
      for (const key of keys) {
        waiters.get(key)?.resolve();
        waiters.delete(key);
      }
    },
    /** Reject prompts whose held envelopes will never be sent. */
    fail(message: string): void {
      const pending = [...waiters.values()];
      waiters.clear();
      for (const waiter of pending) waiter.reject(new Error(message));
    },
  };
}
