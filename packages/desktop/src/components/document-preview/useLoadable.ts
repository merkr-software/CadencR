import { useEffect, useState } from "react";
import { documentErrorMessage } from "./DocumentChrome";

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

/**
 * Run `load` whenever it changes (pass a memoized function) and track its
 * result. Parsing a sheet is synchronous main-thread work, so
 * a frame is yielded first: the loading state paints before it starts.
 */
export function useLoadable<T>(load: () => Promise<T>, failure: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const frame = requestAnimationFrame(() => {
      load()
        .then((value) => {
          if (!cancelled) setState({ status: "ready", value });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({ status: "error", message: documentErrorMessage(error, failure) });
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [failure, load]);
  return state;
}
