import { createLucideIcon, type LucideIcon } from "lucide-react";

/**
 * Custom agent glyph (sleek visor) matching Lucide's 24x24, 2px-stroke geometry.
 * Used anywhere in Cadencr that represents an agent, sub-agent, or provider fallback.
 */
export const AgentIcon: LucideIcon = createLucideIcon("agent", [
  ["rect", { x: "3", y: "5.5", width: "18", height: "13", rx: "5.5", key: "visor" }],
  ["path", { d: "M9.25 10.75v2.5", key: "left-eye" }],
  ["path", { d: "M14.75 10.75v2.5", key: "right-eye" }],
]);
