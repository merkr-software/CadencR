import { createFileRoute, redirect } from "@tanstack/react-router";
import { McpDetail } from "@/components/marketplace/agent/McpDetail";
import { SkillDetail } from "@/components/marketplace/agent/SkillDetail";
import { PluginDetail } from "@/components/marketplace/PluginDetail";
import { isAgentExtensionKind } from "@/lib/agent-extensions";
import { isListingKind } from "@/lib/marketplace-listings";

export const Route = createFileRoute("/marketplace/$kind/$id")({
  beforeLoad: ({ params }) => {
    if (!isListingKind(params.kind) && !isAgentExtensionKind(params.kind))
      throw redirect({ to: "/marketplace" });
  },
  component: PluginDetailRoute,
});

function PluginDetailRoute(): React.JSX.Element | null {
  const { kind, id } = Route.useParams();
  // beforeLoad already redirected anything else; this narrows the type.
  if (kind === "mcp") return <McpDetail key={id} id={id} />;
  if (kind === "skill") return <SkillDetail key={id} id={id} />;
  return isListingKind(kind) ? <PluginDetail kind={kind} id={id} /> : null;
}
