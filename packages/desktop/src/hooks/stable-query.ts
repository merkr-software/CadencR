import { useMemo } from "react";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

// Observer result objects are fresh each render; expose only the state/actions
// consumers need so unrelated parent renders preserve a stable facade.
export function useStableQuery<T>({
  data,
  error,
  isSuccess,
  isError,
  isPending,
  isLoading,
  isFetching,
  refetch,
}: UseQueryResult<T>) {
  return useMemo(
    () => ({ data, error, isSuccess, isError, isPending, isLoading, isFetching, refetch }),
    [data, error, isSuccess, isError, isPending, isLoading, isFetching, refetch],
  );
}

export function useStableMutation<T, V>({
  error,
  isSuccess,
  isError,
  isPending,
  variables,
  mutate,
  mutateAsync,
}: UseMutationResult<T, Error, V>) {
  return useMemo(
    () => ({ error, isSuccess, isError, isPending, variables, mutate, mutateAsync }),
    [error, isSuccess, isError, isPending, variables, mutate, mutateAsync],
  );
}
