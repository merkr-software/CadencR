import { translateUi } from "@/lib/i18n/ui";
import { apiErrorMessage } from "@/lib/api-errors";

export interface FullTreeFetchState {
  count: number | undefined;
  isCountResolved: boolean;
  threshold: number;
}

export interface FileTreeLoadStateInput {
  lazyMode: boolean;
  countIsPending: boolean;
  countIsError: boolean;
  lazyTreeIsLoading: boolean;
  trackedIsLoading: boolean;
  trackedHasData: boolean;
  countError: unknown;
  lazyTreeError: string | null;
  trackedError: unknown;
  trackedIsError: boolean;
}

export interface FileTreeLoadState {
  isLoading: boolean;
  errorMessage: string | null;
}

export function shouldUseLazyTree(count: number | undefined, threshold: number): boolean {
  return (count ?? 0) > threshold;
}

export function shouldFetchFullTree(state: FullTreeFetchState): boolean {
  if (!state.isCountResolved) return false;
  return !shouldUseLazyTree(state.count, state.threshold);
}

export function getFileTreeLoadState(input: FileTreeLoadStateInput): FileTreeLoadState {
  if (input.countIsPending) {
    return { isLoading: true, errorMessage: null };
  }
  if (input.countIsError) {
    return {
      isLoading: false,
      errorMessage: apiErrorMessage(
        input.countError,
        translateUi(
          "workspace.editor.fileTreeLoadMode.countFailed",
          "Failed to count project files",
        ),
      ),
    };
  }
  if (input.lazyMode) {
    return { isLoading: input.lazyTreeIsLoading, errorMessage: input.lazyTreeError };
  }
  return {
    isLoading: input.trackedIsLoading && !input.trackedHasData,
    errorMessage:
      input.trackedIsError && !input.trackedHasData
        ? apiErrorMessage(
            input.trackedError,
            translateUi("workspace.editor.fileTreeLoadMode.loadFailed", "Failed to load file tree"),
          )
        : null,
  };
}
