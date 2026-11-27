import { createFileRoute, redirect } from "@tanstack/react-router";
import { isAgentExtensionKind } from "@/lib/agent-extensions";
import { isListingKind } from "@/lib/marketplace-listings";

/** A listing's page (in `marketplace.$kind.$id.lazy.tsx`); unknown kinds go back to the list. */
export const Route = createFileRoute("/marketplace/$kind/$id")({
  beforeLoad: ({ params }) => {
    if (!isListingKind(params.kind) && !isAgentExtensionKind(params.kind))
      throw redirect({ to: "/marketplace" });
  },
});
