import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { persister, queryClient } from "./lib/queryClient";
import { shouldDehydrateQuery } from "./lib/persistedQueries";
import { OnboardingGate } from "./components/onboarding/OnboardingGate";
import { RemotePairingGate } from "./components/remote/RemotePairingGate";
import { AmbientBackground } from "./components/AmbientBackground";
import { AnimationsProvider } from "./lib/animations/AnimationsProvider";
import { useLinkMenuListener } from "./components/links/useLinkMenuListener";

const PERSIST_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24h

export default function App() {
  useLinkMenuListener();
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        dehydrateOptions: { shouldDehydrateQuery },
      }}
    >
      <AnimationsProvider>
        <AmbientBackground />
        <RemotePairingGate>
          <OnboardingGate>
            <RouterProvider router={router} />
          </OnboardingGate>
        </RemotePairingGate>
      </AnimationsProvider>
    </PersistQueryClientProvider>
  );
}
