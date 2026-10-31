export interface SessionPresentationEffects {
  onUserPromptDispatched(featureId: number): void;
}

let installed: { effects: SessionPresentationEffects } | undefined;

/** The application composition root owns this registration and its teardown. */
export function installSessionPresentationEffects(effects: SessionPresentationEffects): () => void {
  if (installed) throw new Error("Session presentation effects are already installed.");
  const registration = { effects };
  installed = registration;
  return () => {
    if (installed === registration) installed = undefined;
  };
}

export const sessionPresentationEffects: SessionPresentationEffects = {
  onUserPromptDispatched(featureId) {
    if (!installed) throw new Error("Session presentation effects have not been installed.");
    installed.effects.onUserPromptDispatched(featureId);
  },
};
