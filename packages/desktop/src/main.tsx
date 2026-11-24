import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { preloadRuntimeConfig } from "./api/client";
import { ensurePaired } from "./api/remote-pairing";
import { registerPushServiceWorker } from "./lib/remote/push-register";
import { applyThemeToDocument, readPersistedTheme } from "./lib/themes";
import { apiErrorMessage } from "./lib/api-errors";
import { installGlobalRendererErrorHandlers } from "./lib/renderer-error-reporting";
import { installDiagnosticStoreObservers } from "./lib/renderer-diagnostic-observers";
import { installDiagnosticBrowserEvents } from "./lib/renderer-diagnostics";
import { reactRootErrorHandlers } from "./lib/react-root-error-reporting";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { detectStandalone } from "./hooks/useFullscreen";
import { initializeStandaloneViewport } from "./lib/standalone-viewport";
import { mountSessionApplication } from "./lib/session-integration";
import { translateUi } from "./lib/i18n/ui";
import { readSystemLocale } from "./lib/i18n/renderer-language";
import { applyRendererLanguage } from "./lib/i18n/language-document";
import { getPhoneShellSnapshot, installShellAttribute } from "./lib/form-factor";
import { prefetchAgentSession } from "./components/lazy/agent-session-chunk";
import "./index.css";

// Phone or desktop layout on `<html data-shell>`, before the first paint, so the
// `phone:` / `desktop:` CSS already matches what `useIsMobile()` will render.
installShellAttribute();

// iOS caches the status-bar mode when installing a PWA. Seed its viewport
// before React mounts so both new/default and older/translucent installs fit.
if (detectStandalone()) initializeStandaloneViewport();

// Apply the user's last-known theme synchronously before React mounts.
// The server-side workspace setting remains the source of truth; this
// localStorage paint hint only avoids a flash on cold start. `useThemeSync`
// rewrites the cache once the workspace setting resolves.
applyThemeToDocument(readPersistedTheme());
installDiagnosticBrowserEvents();
installGlobalRendererErrorHandlers();
installDiagnosticStoreObservers();

// The conversation view is its own chunk. Every layout but the phone's opens
// on a conversation: boot waits for the chunk, so the conversation's first
// render is the real one, and it starts now, beside pairing and the runtime
// config. `prefetch` attaches its handler at once and never rejects: a failed
// load is left to `LazyAgentSession`, which loads it again under its
// `LazyBoundary` and offers Reload there. The phone layout opens on the
// inbox, which fetches the chunk once its cards are up (`PhoneInbox`).
const agentSessionLoaded = getPhoneShellSnapshot() ? null : prefetchAgentSession();

// Preload the API endpoint before mounting so sync accessors everywhere have
// the config by the time the first request or WebSocket fires.
async function bootstrap(): Promise<void> {
  // In a remote browser, exchange any `#code=` pairing code (or legacy query code) for a device token
  // and persist it *before* the API client reads its config below.
  await ensurePaired();
  await preloadRuntimeConfig();
  if (agentSessionLoaded) await agentSessionLoaded;
  // Register the push service worker in the web/PWA shell (no-op in Electron and
  // when push is unsupported). Fire-and-forget — it must not block first paint,
  // and actually subscribing is a separate user-gesture flow in settings.
  void registerPushServiceWorker();
  const dispose = mountSessionApplication(() => {
    const root = createRoot(document.getElementById("root")!, reactRootErrorHandlers);
    root.render(
      <React.StrictMode>
        <GlobalErrorBoundary>
          <App />
        </GlobalErrorBoundary>
      </React.StrictMode>,
    );
    return () => root.unmount();
  });
  import.meta.hot?.dispose(dispose);
}

bootstrap().catch((err) => {
  console.error("Cadencr bootstrap failed:", err);
  const root = document.getElementById("root");
  if (!root) return;
  const showFailure = () => {
    root.textContent = translateUi(
      "shell.errors.bootstrapFailed",
      "Failed to start Cadencr: {{detail}}",
      { detail: apiErrorMessage(err, String(err)) },
    );
  };
  showFailure();
  void applyRendererLanguage(readSystemLocale()).then(showFailure, (languageError: unknown) => {
    console.error("Could not localize the startup error", languageError);
  });
});
