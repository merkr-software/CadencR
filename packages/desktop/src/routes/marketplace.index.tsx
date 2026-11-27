import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PLUGIN_KINDS } from "@/lib/marketplace-listings";
import { AGENT_EXTENSION_KINDS } from "@/lib/agent-extensions";
import { MARKETPLACE_VIEWS } from "@/lib/marketplace-views";

const searchSchema = z.object({
  view: z.enum(MARKETPLACE_VIEWS).optional().catch(undefined),
  kind: z
    .enum(["all", ...PLUGIN_KINDS, ...AGENT_EXTENSION_KINDS])
    .optional()
    .catch(undefined),
  q: z.string().optional().catch(undefined),
});

/** The marketplace home's search; the page is in `marketplace.index.lazy.tsx`. */
export const Route = createFileRoute("/marketplace/")({
  validateSearch: (search: Record<string, unknown>) => searchSchema.parse(search),
});
