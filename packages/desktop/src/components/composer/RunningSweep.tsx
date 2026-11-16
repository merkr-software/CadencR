import type { ReactElement } from "react";

/** The faint reflection that crosses the composer's top edge while the agent works. */
export function RunningSweep(): ReactElement {
  return <div aria-hidden className="composer-sweep" />;
}
