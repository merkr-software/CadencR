import { createFileRoute, redirect } from "@tanstack/react-router";
import { getPhoneShellSnapshot } from "@/lib/form-factor";

/**
 * The unified agents grid; its page is in `agents.lazy.tsx`. The phone layout
 * is sent to `#/` (its "Agents" is the inbox there) before the grid's chunk
 * loads; the page sends it there too when the layout flips while it shows.
 */
export const Route = createFileRoute("/agents")({
  beforeLoad: () => {
    if (getPhoneShellSnapshot()) throw redirect({ to: "/", replace: true });
  },
});
