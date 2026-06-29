import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

/**
 * 240px left rail for the settings page. Renders grouped nav links that
 * scroll the main pane to the matching `<section data-section="…">` and
 * auto-track the active section as the user scrolls.
 *
 * Uses IntersectionObserver against the scrollable main element so we don't
 * read layout (`offsetTop`) on every scroll tick.
 */
function SettingsNavSidebarImpl({
  groups,
  scrollRef,
  header,
  footer,
}: {
  groups: SettingsNavGroup[];
  /** Ref to the scrollable main element used as the IntersectionObserver root. */
  scrollRef: RefObject<HTMLElement | null>;
  header?: ReactNode;
  footer?: ReactNode;
}): React.JSX.Element {
  const sectionIds = useMemo(
    () => groups.flatMap((group) => group.items.map((item) => item.id)),
    [groups],
  );
  const [activeId, setActiveId] = useState<string>(() => sectionIds[0] ?? "");
  // While a click-to-scroll is animating we hold the clicked item active and
  // ignore observer churn — see `scrollTo`. `releaseClickScroll` clears the
  // pending hold (pointer to its own teardown so a second click can cancel it).
  const clickScrolling = useRef(false);
  const releaseClickScroll = useRef<(() => void) | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // The observed region is everything below a "reading line" ~80px from the
    // root's top. A section keeps intersecting until it scrolls fully above
    // that line, so the active section is the FIRST (topmost) one still under
    // it — the section currently occupying the reading line. Picking the *last*
    // intersecting instead made a short section hand off to the next one the
    // moment its heading peeked into view (e.g. Runtime → Git).
    const visibility = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibility.set(entry.target.id, entry.intersectionRatio);
        }
        // A click-to-scroll already set the target active; don't let the
        // sections it flies past flicker the highlight mid-animation.
        if (clickScrolling.current) return;
        let next = sectionIds[0];
        for (const id of sectionIds) {
          if ((visibility.get(id) ?? 0) > 0) {
            next = id;
            break;
          }
        }
        setActiveId((prev) => (prev === next ? prev : next));
      },
      {
        root,
        // Reading line ~80px below the root's top (matching `scrollTo`'s offset);
        // the region runs to the bottom so a section stays active until its
        // whole body has scrolled past the line.
        rootMargin: "-80px 0px 0px 0px",
        threshold: [0, 1],
      },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sectionIds, scrollRef]);

  // Drop any pending click-scroll hold when the component unmounts.
  useEffect(() => () => releaseClickScroll.current?.(), []);

  function scrollTo(id: string): void {
    const root = scrollRef.current;
    const target = document.getElementById(id);
    if (!root || !target) return;

    // Honor the click immediately and keep it active until the smooth scroll
    // settles. The target can sit below the fold (e.g. the last, short section
    // can't reach the top), so scroll position alone can't always re-derive it.
    setActiveId(id);
    clickScrolling.current = true;
    releaseClickScroll.current?.();

    let timer = 0;
    const release = (): void => {
      clickScrolling.current = false;
      root.removeEventListener("scrollend", release);
      window.clearTimeout(timer);
      releaseClickScroll.current = null;
    };
    // Arm the release before scrolling so a `scrollend` can't slip past us.
    // `scrollend` fires once the animation finishes; the timer is a fallback.
    timer = window.setTimeout(release, 1000);
    root.addEventListener("scrollend", release);
    releaseClickScroll.current = release;

    root.scrollTo({ top: target.offsetTop - 16, behavior: "smooth" });
  }

  return (
    <aside
      style={{ width: 240, flexShrink: 0 }}
      // Phones get the full width for content; sections still scroll in `main`,
      // reachable from the workspace drawer's Settings link.
      className="hidden flex-col border-r border-border bg-[var(--sidebar)] md:flex"
    >
      {header ? <div className="px-4 pt-5 pb-3">{header}</div> : null}

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-3 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = item.id === activeId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => scrollTo(item.id)}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-3 text-left text-[13px] transition-colors",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  aria-current={active ? "true" : undefined}
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-sm bg-primary"
                    />
                  ) : null}
                  <span className="grid size-4 place-items-center">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {footer ? (
        <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </aside>
  );
}

export const SettingsNavSidebar = memo(SettingsNavSidebarImpl);
