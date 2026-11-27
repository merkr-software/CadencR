import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { LanguageProvider } from "./lib/i18n/LanguageProvider";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { persister, queryClient, revalidateRestoredQueries } from "./lib/queryClient";
import { shouldDehydrateQuery } from "./lib/persistedQueries";
import { OnboardingGate } from "./components/onboarding/OnboardingGate";
import { LanguageUpgradeSuggestion } from "./components/onboarding/LanguageUpgradeSuggestion";
import { isBrowserRemote } from "./lib/remote/device-token";
import { RemotePairingGate } from "./components/remote/RemotePairingGate";
import { Toaster } from "./components/ui/sonner";
import { AmbientBackground } from "./components/AmbientBackground";
import { AnimationsProvider } from "./lib/animations/AnimationsProvider";
import { MonoFontProvider } from "@/lib/fonts/MonoFontProvider";
import { useLinkMenuListener } from "./components/links/useLinkMenuListener";
import { useConversationPreloadIntent } from "./hooks/useConversationPreloadIntent";

const PERSIST_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24h

export default function App() {
  useLinkMenuListener();
  useConversationPreloadIntent();
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        dehydrateOptions: { shouldDehydrateQuery },
      }}
      onSuccess={revalidateRestoredQueries}
    >
      <AnimationsProvider>
        <MonoFontProvider>
          <AmbientBackground />
          <Toaster />
          <RemotePairingGate>
            <LanguageProvider>
              <OnboardingGate openSettings={() => router.navigate({ to: "/settings" })}>
                <RouterProvider router={router} />
                {!isBrowserRemote() && <LanguageUpgradeSuggestion />}
              </OnboardingGate>
            </LanguageProvider>
          </RemotePairingGate>
        </MonoFontProvider>
      </AnimationsProvider>
    </PersistQueryClientProvider>
  );
}
