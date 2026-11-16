import {
  createRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  INSTRUMENT_SLOTS,
  SESSION_SLOTS,
  ZONES,
  chooseSplit,
  zoneSlots,
  type InstrumentSlot,
  type InstrumentSpacing,
  type Zone,
} from "./instrument-layout";

/**
 * Row width, in rem, below which instruments drop their labels — the
 * `composer-instruments` container query in composer.css (keep in sync).
 */
const COMPACT_ROW_REM = 30;

type Hosts = Record<InstrumentSlot, HTMLDivElement>;

export type PlaceInstrument = (slot: InstrumentSlot, node: ReactNode) => ReactNode;

export type InstrumentZones = Record<Zone, RefObject<HTMLDivElement | null>>;

export interface InstrumentRows {
  /** Whether the session controls sit in a header atop the card. */
  split: boolean;
  /** Renders an instrument into its slot, wherever that slot currently sits. */
  place: PlaceInstrument;
  /** The bottom instrument row, whose width both rows share. */
  rowRef: RefObject<HTMLDivElement | null>;
  zones: InstrumentZones;
}

const SESSION = new Set<InstrumentSlot>(SESSION_SLOTS);

function createHosts(): Hosts {
  const entries = INSTRUMENT_SLOTS.map((slot) => {
    const host = document.createElement("div");
    host.dataset.composerSlot = slot;
    // Session controls are set off from each other by hairlines (composer.css).
    if (SESSION.has(slot)) host.dataset.composerGroup = "";
    return [slot, host] as const;
  });
  return Object.fromEntries(entries) as Hosts;
}

function createZones(): InstrumentZones {
  return Object.fromEntries(
    ZONES.map((zone) => [zone, createRef<HTMLDivElement>()]),
  ) as InstrumentZones;
}

/** Moves only the hosts that are out of place, keeping focus on a moved control. */
function arrange(zone: HTMLElement, hosts: HTMLDivElement[]): void {
  hosts.forEach((host, index) => {
    if (zone.children[index] === host) return;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && host.contains(active) ? active : null;
    zone.insertBefore(host, zone.children[index] ?? null);
    focused?.focus({ preventScroll: true });
  });
}

function measure(row: HTMLElement, zones: InstrumentZones, hosts: Hosts) {
  const rowStyle = getComputedStyle(row);
  const available =
    row.getBoundingClientRect().width -
    parseFloat(rowStyle.paddingLeft) -
    parseFloat(rowStyle.paddingRight);
  const left = zones.bottomLeft.current;
  const right = zones.bottomRight.current;
  // Hidden behind a question or permission prompt: nothing to lay out yet.
  if (!(available > 0) || !left || !right) return null;
  const leftStyle = getComputedStyle(left);
  // The hairline between two session groups (0 on compact rows).
  const hairline = parseFloat(leftStyle.getPropertyValue("--composer-hairline-space")) || 0;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const spacing: InstrumentSpacing = {
    available,
    compactBelow: COMPACT_ROW_REM * rem,
    rowGap: parseFloat(rowStyle.columnGap) || 0,
    sessionGap: (parseFloat(leftStyle.columnGap) || 0) + hairline,
    trailingGap: parseFloat(getComputedStyle(right).columnGap) || 0,
  };
  const widths = Object.fromEntries(
    INSTRUMENT_SLOTS.map((slot) => [slot, hosts[slot].getBoundingClientRect().width]),
  ) as Record<InstrumentSlot, number>;
  return { spacing, widths };
}

/**
 * Lays the composer's instruments out on one row under the editor, or on two
 * — a session header atop the card and the row under the editor — once one
 * row no longer fits (see `instrument-layout.ts` for the rule).
 *
 * Every instrument renders through a portal into its own stable host node, and
 * a new layout only moves hosts between zones — the controls never remount, so
 * an open picker or menu stays open and keyboard focus follows the control.
 * Every host stays at its natural width, which is what the layout measures.
 * (Same stable-host idea as `feature-layout/TabContentRegistry.tsx`.)
 */
export function useInstrumentRows(): InstrumentRows {
  const [hosts] = useState(createHosts);
  const [zones] = useState(createZones);
  const [attached, setAttached] = useState(false);
  const [split, setSplit] = useState(false);
  const splitRef = useRef(split);
  const rowRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    splitRef.current = split;
    const slots = zoneSlots(split);
    for (const zone of ZONES) {
      const element = zones[zone].current;
      if (element)
        arrange(
          element,
          slots[zone].map((slot) => hosts[slot]),
        );
    }
    // Instruments render only once their hosts are in the card, so their own
    // layout effects never measure a detached node.
    setAttached(true);
  }, [hosts, split, zones]);

  useLayoutEffect(
    () => () => {
      for (const host of Object.values(hosts)) host.remove();
    },
    [hosts],
  );

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const measured = measure(row, zones, hosts);
      if (!measured) return;
      const next = chooseSplit(splitRef.current, measured.widths, measured.spacing);
      if (next === splitRef.current) return;
      splitRef.current = next;
      // Before paint: the card never shows a frame of the outgoing layout.
      flushSync(() => setSplit(next));
    });
    observer.observe(row);
    for (const host of Object.values(hosts)) observer.observe(host);
    return () => observer.disconnect();
  }, [hosts, zones]);

  const place = useCallback<PlaceInstrument>(
    (slot, node) => (attached ? createPortal(node, hosts[slot]) : null),
    [attached, hosts],
  );

  return useMemo(() => ({ split, place, rowRef, zones }), [split, place, zones]);
}
