import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { preloadRuntimeConfig } from "./api/client";
import { ensurePaired } from "./api/remote-pairing";
import { registerPushServiceWorker } from "./lib/remote/push-register";
import { applyThemeToDocument, readPersistedTheme } from "./lib/themes";
import { apiErrorMessage } from "./lib/api-errors";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { detectStandalone } from "./hooks/useFullscreen";
import { initializeStandaloneViewport } from "./lib/standalone-viewport";
import "./index.css";

// iOS caches the status-bar mode when installing a PWA. Seed its viewport
// before React mounts so both new/default and older/translucent installs fit.
if (detectStandalone()) initializeStandaloneViewport();

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
    root.textContent = `Failed to start Cadencr: ${apiErrorMessage(err, String(err))}`;
  }
});
