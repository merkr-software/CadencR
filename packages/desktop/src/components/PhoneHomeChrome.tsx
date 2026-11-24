import type { ReactElement, ReactNode } from "react";
import { Loader2Icon, PlusIcon } from "lucide-react";

import { useSidebarCollapsed } from "@/components/SidebarContext";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { Button } from "@/components/ui/button";
import { useStartConversation } from "@/hooks/useStartConversation";

/**
 * The phone layout's home page has no conversation header, so it carries its
 * own 44px row with the menu button: the drawer is always one tap away.
 */
export function PhoneHomeFrame({ children }: { children: ReactNode }): ReactElement {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center pl-3">
        <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * An empty project's call to action on a phone, where the sidebar's "+" is
 * behind the menu: the same action (`useStartConversation`).
 */
export function NewConversationButton({ projectId }: { projectId: number }): ReactElement {
  const { start, isPending } = useStartConversation();
  return (
    <Button className="mt-4 min-h-11" disabled={isPending} onClick={() => start(projectId)}>
      {isPending ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
      New conversation
    </Button>
  );
}
