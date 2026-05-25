/**
 * Shared test utilities for renderer tests.
 * Provides custom render with QueryClient provider and helpers.
 */
import React from "react";
import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Re-export everything from testing-library
export * from "@testing-library/react";

/**
 * Creates a fresh QueryClient suitable for tests (no retries, no cache time).
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        cacheTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Custom render
// ---------------------------------------------------------------------------

interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient;
}

/**
 * Custom render that wraps children in QueryClient provider.
 * A fresh QueryClient is created per call unless one is provided.
 */
export function render(ui: React.ReactElement, options: CustomRenderOptions = {}) {
  const { queryClient = createTestQueryClient(), ...renderOptions } = options;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  const user = userEvent.setup();
  return {
    user,
    ...rtlRender(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

export type QueryPredicate = (query: { queryKey: readonly unknown[] }) => boolean;

export function getInvalidatePredicate(options: unknown): QueryPredicate {
  if (typeof options !== "object" || options === null || !("predicate" in options)) {
    throw new Error("Expected invalidateQueries to receive a predicate");
  }
  const predicate = (options as { predicate?: unknown }).predicate;
  if (typeof predicate !== "function") {
    throw new Error("Expected invalidateQueries predicate to be a function");
  }
  return predicate as QueryPredicate;
}
