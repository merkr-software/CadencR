import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bookmark,
  CalendarDays,
  Check,
  ChevronsUpDown,
  CircleDot,
  Folder,
  GitBranch,
  List,
  Sparkles,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { EYEBROW_TEXT_CLASS } from "@/components/SidebarBlock";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LENS_OPTIONS } from "@/components/sidebar-display-rows";
import { useSetSidebarOption } from "@/hooks/useSidebarSettings";
import { useSidebarViews } from "@/hooks/useSidebarViews";
import { SIDEBAR_VIEWS_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import type { SidebarLens } from "@/lib/sidebar-lens";
import { cn } from "@/lib/utils";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/** The name the Projects header takes: the shown view's, else the lens's. */
function headerName(lens: SidebarLens, viewName: string | undefined): string {
  if (viewName !== undefined) return viewName || "Untitled view";
  if (lens === "project") return "Projects";
  if (lens === "flat") return "Conversations";
  const label = LENS_OPTIONS.find((option) => option.value === lens)?.label ?? lens;
  return `By ${label.toLowerCase()}`;
}

/** The header's icon, like the blocks above it: says how the list is grouped. */
const LENS_ICONS: Record<SidebarLens, LucideIcon> = {
  project: Folder,
  status: CircleDot,
  worktree: GitBranch,
  provider: Sparkles,
  label: Tag,
  date: CalendarDays,
  flat: List,
};

/** The header's icon and name, in the sidebar's section label type. */
function LensLabel({ icon: Icon, name }: { icon: LucideIcon; name: string }): ReactElement {
  return (
    <>
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </>
  );
}

/**
 * The header's static name and icon, for the Settings preview: the same label
 * the sidebar's header menu shows for the current lens.
 */
export function SidebarLensHeading(): ReactElement {
  const lens = useSidebarOption("lens");
  return (
    <div className={cn(EYEBROW_TEXT_CLASS, "flex min-w-0 items-center gap-1.5")}>
      <LensLabel icon={LENS_ICONS[lens]} name={headerName(lens, undefined)} />
    </div>
  );
}

function MenuCheck({ on }: { on: boolean }): ReactElement {
  return <Check className={on ? "size-3.5" : "size-3.5 opacity-0"} />;
}

/**
 * The Projects header's name, as a menu: how conversations are grouped (the
 * "Group by" option) and the saved views, one click away. It opens on click,
 * not on press like other menus: pressing the name may start dragging the
 * whole project list by its header, which a menu opened on press would stop.
 */
export function SidebarLensMenu(): ReactElement {
  const lens = useSidebarOption("lens");
  const setOption = useSetSidebarOption();
  const { views, activeView, showView } = useSidebarViews();
  const navigate = useNavigate();
  const menu = useClickToOpenMenu();
  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      {/* Radix opens its trigger on press; disabled, it leaves the press to the
          drag and this element opens the menu itself (click, Enter, Space, ↓). */}
      <DropdownMenuTrigger asChild disabled>
        <span
          role="button"
          tabIndex={0}
          data-sidebar-lens-menu
          {...menu.triggerProps}
          className={cn(
            EYEBROW_TEXT_CLASS,
            "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:text-foreground",
          )}
        >
          <LensLabel
            icon={activeView ? Bookmark : LENS_ICONS[lens]}
            name={headerName(lens, activeView?.name)}
          />
          <ChevronsUpDown className="size-3 shrink-0 opacity-70" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Group by</DropdownMenuLabel>
        {LENS_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => {
              if (activeView) showView(null);
              if (option.value !== lens) setOption("lens", option.value);
            }}
          >
            <MenuCheck on={activeView === null && option.value === lens} />
            {option.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Views</DropdownMenuLabel>
        {views.map((view) => (
          <DropdownMenuItem key={view.id} onSelect={() => showView(view.id)}>
            <MenuCheck on={view.id === activeView?.id} />
            <span className="truncate">{view.name || "Untitled view"}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onSelect={() =>
            void navigate({ to: "/settings", search: { section: SIDEBAR_VIEWS_SETTINGS_ANCHOR } })
          }
        >
          <MenuCheck on={false} />
          {views.length === 0 ? "Create a view…" : "Manage views…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A menu trigger that opens on click and from the keyboard. A click on the
 * open menu's trigger closes it: the press outside the menu has closed it
 * already, so the click must not open it again.
 */
function useClickToOpenMenu(): {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerProps: {
    onPointerDown: () => void;
    onClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
} {
  const [open, setOpen] = useState(false);
  const openAtPress = useRef(false);
  return {
    open,
    setOpen,
    triggerProps: {
      onPointerDown: () => {
        openAtPress.current = open;
      },
      onClick: () => {
        setOpen(!openAtPress.current);
        openAtPress.current = false;
      },
      onKeyDown: (event) => {
        if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        setOpen(true);
      },
    },
  };
}
