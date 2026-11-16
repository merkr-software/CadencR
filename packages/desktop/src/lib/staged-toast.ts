/**
 * Spread first into every later stage of a toast that keeps one id. Sonner
 * merges each call's options into the toast already shown under that id, so
 * an earlier stage's description, buttons and lifetime would otherwise leak
 * onto the progress or result stages.
 */
export const RESET_TOAST_STAGE = {
  description: undefined,
  action: undefined,
  cancel: undefined,
  duration: undefined,
};
