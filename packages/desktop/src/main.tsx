import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { preloadRuntimeConfig } from "./api/client";
import { ensurePaired } from "./api/remote-pairing";
import { registerPushServiceWorker } from "./lib/remote/push-register";
import { applyThemeToDocument, readPersistedTheme } from "./lib/themes";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { detectStandalone } from "./hooks/useFullscreen";
import "./index.css";

// In an iOS "Add to Home Screen" standalone app, `dvh`/`%`/`fixed` resolve to
// the screen height *minus the status-bar inset* (a top-anchored short
// viewport), while only `lvh` spans the full screen. Tag the document so CSS
// can switch the `--app-vh` height unit accordingly (see index.css). The
// `display-mode: standalone` media query is unreliable on iOS, so this relies
// on `navigator.standalone`.
if (detectStandalone()) document.documentElement.classList.add("is-standalone");

// Apply the user's last-known theme synchronously before React mounts.
// The server-side workspace setting remains the source of truth; this
// localStorage paint hint only avoids a flash on cold start. `useThemeSync`
// rewrites the cache once the workspace setting resolves.
applyThemeToDocument(readPersistedTheme());
installGlobalRendererErrorHandlers();

// Preload port + token before mounting so sync accessors everywhere have
// the config by the time the first request or WebSocket fires.
async function bootstrap(): Promise<void> {
  // In a remote browser, exchange any `?code=` pairing code for a device token
  // and persist it *before* the API client reads its config below.
  await ensurePaired();
  await preloadRuntimeConfig();
  // Register the push service worker in the web/PWA shell (no-op in Electron and
  // when push is unsupported). Fire-and-forget — it must not block first paint,
  // and actually subscribing is a separate user-gesture flow in settings.
  void registerPushServiceWorker();
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <GlobalErrorBoundary>
        <App />
      </GlobalErrorBoundary>
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  console.error("Cadencr bootstrap failed:", err);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Failed to start Cadencr: ${err instanceof Error ? err.message : String(err)}`;
  }
});
