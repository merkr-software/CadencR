import { createFileRoute, redirect } from "@tanstack/react-router";
import { PluginDetail } from "@/components/marketplace/PluginDetail";
import { isListingKind } from "@/lib/marketplace-listings";

export const Route = createFileRoute("/marketplace/$kind/$id")({
  beforeLoad: ({ params }) => {
    if (!isListingKind(params.kind)) throw redirect({ to: "/marketplace" });
  },
  component: PluginDetailRoute,
});

function PluginDetailRoute(): React.JSX.Element | null {
  const { kind, id } = Route.useParams();
  // beforeLoad already redirected anything else; this narrows the type.
  return isListingKind(kind) ? <PluginDetail kind={kind} id={id} /> : null;
}
