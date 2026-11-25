import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Fragment } from "react";
import { LanguageProvider } from "./lib/i18n/LanguageProvider";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { persister, queryClient, revalidateRestoredQueries } from "./lib/queryClient";
import { shouldDehydrateQuery } from "./lib/persistedQueries";
import { OnboardingGate } from "./components/onboarding/OnboardingGate";
import { RemotePairingGate } from "./components/remote/RemotePairingGate";
import { AmbientBackground } from "./components/AmbientBackground";
import { AnimationsProvider } from "./lib/animations/AnimationsProvider";
import { MonoFontProvider } from "@/lib/fonts/MonoFontProvider";
import { useLinkMenuListener } from "./components/links/useLinkMenuListener";
import { useConversationPreloadIntent } from "./hooks/useConversationPreloadIntent";

const PERSIST_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24h

// The two sample catalogs are available in development and QA until the product copy is localized.
const LanguageBoundary = import.meta.env.DEV ? LanguageProvider : Fragment;

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
          <RemotePairingGate>
            <LanguageBoundary>
              <OnboardingGate openSettings={() => router.navigate({ to: "/settings" })}>
                <RouterProvider router={router} />
              </OnboardingGate>
            </LanguageBoundary>
          </RemotePairingGate>
        </MonoFontProvider>
      </AnimationsProvider>
    </PersistQueryClientProvider>
  );
}
