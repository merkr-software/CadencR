import { createContext, useContext, type ReactNode } from "react";
import { useResolvedModel } from "@/hooks/useResolvedModel";

export type ResolvedModelValue = ReturnType<typeof useResolvedModel>;

const ResolvedModelContext = createContext<ResolvedModelValue | null>(null);

interface ResolvedModelProviderProps {
  featureId: number;
  children: ReactNode;
}

/**
 * Hosts a single `useResolvedModel(featureId)` call at the route
 * level so tab bodies can share the same settings/provider fetches on cold
 * open.
 */
export function ResolvedModelProvider({
  featureId,
  children,
}: ResolvedModelProviderProps): ReactNode {
  const value = useResolvedModel(featureId);
  return <ResolvedModelContext.Provider value={value}>{children}</ResolvedModelContext.Provider>;
}

export function useResolvedModelContext(): ResolvedModelValue {
  const value = useContext(ResolvedModelContext);
  if (!value) {
    throw new Error("useResolvedModelContext must be used inside <ResolvedModelProvider />");
  }
  return value;
}
