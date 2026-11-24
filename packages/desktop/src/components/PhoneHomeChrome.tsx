import type { ReactElement, ReactNode } from "react";

import { useSidebarCollapsed } from "@/components/SidebarContext";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";

/**
 * The phone layout's home page has no conversation header, so it carries its
 * own 44px row with the menu button: the drawer is always one tap away. The
 * inbox names itself there and puts its action at the row's end; it lists For
 * me itself, so its menu button carries no attention dot.
 */
export function PhoneHomeFrame({
  title,
  actions,
  menuBadge = true,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  menuBadge?: boolean;
  children: ReactNode;
}): ReactElement {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 pr-1 pl-3">
        <SidebarCollapsedChrome
          visible={collapsed}
          onExpand={() => setCollapsed(false)}
          menuBadge={menuBadge}
        />
        {title && (
          <h1 className="min-w-0 flex-1 truncate text-base leading-6 font-semibold">{title}</h1>
        )}
        {actions && <div className="ml-auto flex shrink-0 items-center">{actions}</div>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A page's only message, centered: loading, an empty state or a failure, with
 * an action under it (New conversation). The title is muted by default, in the
 * foreground for an empty state that leads the page, in `--destructive` for an
 * error.
 */
export function CenteredMessage({
  title,
  detail,
  tone = "muted",
  action,
}: {
  title: string;
  detail?: string;
  tone?: "muted" | "foreground" | "error";
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <p className={TITLE_TONE[tone]}>{title}</p>
        {detail ? <p className="mt-2 text-sm text-muted-foreground">{detail}</p> : null}
        {action}
      </div>
    </div>
  );
}

const TITLE_TONE = {
  muted: "text-muted-foreground",
  foreground: "text-foreground",
  error: "text-destructive",
} as const;
