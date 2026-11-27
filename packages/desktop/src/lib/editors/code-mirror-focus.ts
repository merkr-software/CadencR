const editors = new Map<number, () => void>();

export function registerCodeMirrorFocus(featureId: number, focus: () => void): () => void {
  editors.set(featureId, focus);
  return () => {
    if (editors.get(featureId) === focus) editors.delete(featureId);
  };
}

export function requestCodeMirrorFocus(featureId: number): void {
  requestAnimationFrame(() => editors.get(featureId)?.());
}
