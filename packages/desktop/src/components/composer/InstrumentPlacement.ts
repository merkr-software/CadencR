import { createContext, useContext } from "react";
import type { PlaceInstrument } from "./useInstrumentRows";

/**
 * Lets instruments rendered by the session embedder (mode, model, access)
 * claim their slot in the composer's instrument rows. Absent outside a composer
 * card, where the instruments keep their own single strip.
 */
export const InstrumentPlacementContext = createContext<PlaceInstrument | null>(null);

export function useInstrumentPlacement(): PlaceInstrument | null {
  return useContext(InstrumentPlacementContext);
}
