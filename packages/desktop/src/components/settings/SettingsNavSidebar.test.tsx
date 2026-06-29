import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render } from "@/test-utils";
import { SettingsNavSidebar, type SettingsNavGroup } from "./SettingsNavSidebar";

// A controllable IntersectionObserver: capture the callback and observed
// targets so each test can drive intersection entries deterministically. The
// global mock in test-setup fires `isIntersecting: true` with no ratio, which
// can't exercise the active-section selection — this replaces it locally.
type Entry = Pick<IntersectionObserverEntry, "target" | "intersectionRatio" | "isIntersecting">;

let ioCallback: IntersectionObserverCallback | null = null;
let observed: Element[] = [];

class ControllableIO {
  root: Element | null = null;
  rootMargin = "";
  thresholds: ReadonlyArray<number> = [];
  constructor(cb: IntersectionObserverCallback) {
    ioCallback = cb;
  }
  observe = (el: Element): void => {
    observed.push(el);
  };
  unobserve = (): void => {};
  disconnect = (): void => {
    observed = [];
  };
  takeRecords = (): IntersectionObserverEntry[] => [];
}

/** Drive the observer with each section's current intersection ratio. */
function fire(ratios: Record<string, number>): void {
  // Guard against a broken setup silently passing: if the component never
  // constructed the observer, there's nothing to drive and the test is moot.
  if (!ioCallback) throw new Error("IntersectionObserver callback was not registered");
  const entries: Entry[] = observed.map((target) => ({
    target,
    intersectionRatio: ratios[target.id] ?? 0,
    isIntersecting: (ratios[target.id] ?? 0) > 0,
  }));
  act(() => {
    ioCallback?.(entries as IntersectionObserverEntry[], {} as IntersectionObserver);
  });
}

const SECTION_IDS = ["interface", "notifications", "runtime", "git"];

const GROUPS: SettingsNavGroup[] = [
  {
    label: "General",
    items: [
      { id: "interface", label: "Interface & Zoom", icon: null },
      { id: "notifications", label: "Notifications", icon: null },
      { id: "runtime", label: "Runtime & Models", icon: null },
      { id: "git", label: "Git", icon: null },
    ],
  },
];

function activeLabel(): string | null {
  const active = document.querySelector('button[aria-current="true"]');
  return active?.textContent?.trim() ?? null;
}

function renderSidebar() {
  // The observer resolves sections via document.getElementById — they must
  // exist in the document for it to attach.
  for (const id of SECTION_IDS) {
    const el = document.createElement("section");
    el.id = id;
    document.body.appendChild(el);
  }
  const scrollRef = { current: document.createElement("main") };
  document.body.appendChild(scrollRef.current);
  return render(<SettingsNavSidebar groups={GROUPS} scrollRef={scrollRef} />);
}

describe("SettingsNavSidebar active section", () => {
  const originalIO = window.IntersectionObserver;

  beforeEach(() => {
    ioCallback = null;
    observed = [];
    // test-setup defines IntersectionObserver as writable (not configurable),
    // so reassign rather than redefine.
    window.IntersectionObserver = ControllableIO as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    window.IntersectionObserver = originalIO;
    document.body.innerHTML = "";
  });

  it("highlights the first section by default", () => {
    renderSidebar();
    expect(activeLabel()).toBe("Interface & Zoom");
  });

  it("keeps the topmost section active while the next one only peeks into view", () => {
    renderSidebar();
    // Regression for #63: the user is reading "Interface & Zoom" while the
    // "Notifications" heading has scrolled into the lower viewport. Both sit
    // below the reading line, so both report a positive ratio. The active item
    // must stay the topmost one (Interface), not jump ahead to Notifications.
    fire({ interface: 0.4, notifications: 0.2, runtime: 0, git: 0 });
    expect(activeLabel()).toBe("Interface & Zoom");
  });

  it("selects a short section over the following one when both are under the line", () => {
    renderSidebar();
    // Regression for the reported repro: a short "Runtime & Models" section and
    // the next "Git" section are both under the reading line at once. The old
    // "last intersecting" logic picked Git; it must now resolve to Runtime.
    fire({ interface: 0, notifications: 0, runtime: 0.3, git: 0.5 });
    expect(activeLabel()).toBe("Runtime & Models");
  });

  it("advances only once the previous section scrolls past the reading line", () => {
    renderSidebar();
    fire({ interface: 0, notifications: 0, runtime: 0.3, git: 0.5 });
    expect(activeLabel()).toBe("Runtime & Models");

    // Runtime has now scrolled fully above the line (ratio 0); Git is the
    // topmost section still below it.
    fire({ interface: 0, notifications: 0, runtime: 0, git: 0.6 });
    expect(activeLabel()).toBe("Git");
  });
});
