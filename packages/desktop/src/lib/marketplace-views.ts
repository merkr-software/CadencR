/** The marketplace home's views, read by its route's search schema. */
export const MARKETPLACE_VIEWS = ["discover", "installed", "updates"] as const;
export type MarketplaceView = (typeof MARKETPLACE_VIEWS)[number];
