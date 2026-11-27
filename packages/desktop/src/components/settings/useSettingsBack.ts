import { useCallback, useRef } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { readSavedFeature } from "@/lib/saved-feature";

/**
 * Settings' way out ("Back to workspace", Escape). The desktop layout goes to
 * `#/`, which reopens the last conversation. In the phone layout `#/` is the
 * Agents inbox, so Back returns where Settings was opened from: the history
 * entry before it (stepping over the settings pages visited since), else the
 * last conversation on this device, else the inbox.
 */
export function useSettingsBack(phone: boolean): () => void {
  const router = useRouter();
  const navigate = useNavigate();
  // The earliest history entry Settings has shown: the route stays mounted
  // while its pages change, and a Back into a later settings entry remounts it
  // there, so keep the lowest index seen.
  const currentIndex = router.history.location.state.__TSR_index;
  const openedAtRef = useRef(currentIndex);
  openedAtRef.current = Math.min(openedAtRef.current, currentIndex);
  return useCallback(() => {
    if (!phone) {
      void navigate({ to: "/" });
      return;
    }
    const openedAt = openedAtRef.current;
    const delta = openedAt - 1 - router.history.location.state.__TSR_index;
    // Only a step backward out of Settings; anything else (no entry before it,
    // or a stale index) falls back to the saved conversation.
    if (openedAt > 0 && delta < 0) {
      router.history.go(delta);
      return;
    }
    const saved = readSavedFeature();
    if (!saved) {
      void navigate({ to: "/" });
      return;
    }
    void navigate({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: String(saved.projectId), featureId: String(saved.featureId) },
    });
  }, [navigate, phone, router]);
}
