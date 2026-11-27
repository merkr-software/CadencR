import { UiTrans } from "@/lib/i18n/ui";
/**
 * Small top-of-screen banner shown only while the OS is suspended (or in
 * the brief window before the renderer has reconciled with backend after
 * wake). Reads `usePowerStore.suspended`, which is set by `usePowerEvents`
 * from Electron's `powerMonitor` events.
 *
 * Provider-neutral: covers every active agent, no matter which provider.
 *
 * Styling follows the existing "warning-amber" treatment used by
 * `PermissionRequestPendingIndicator` so this looks at home in the rest of
 * the app (see DESIGN.md — amber = "needs attention").
 */

import { usePowerStore } from "@/stores/power-store";

export function SuspendedBanner() {
  const suspended = usePowerStore((state) => state.suspended);
  if (!suspended) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-2 z-40 flex justify-center"
    >
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 shadow-sm">
        <UiTrans
          i18nKey="shell.power.sleeping"
          defaults="System sleeping — agents paused. They’ll reconnect when you wake the machine."
        />
      </div>
    </div>
  );
}
