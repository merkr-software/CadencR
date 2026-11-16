import { create } from "zustand";

/**
 * A "find this in that conversation" request, from a message hit in the
 * command palette. The conversation's find bar takes it once its transcript is
 * on screen (it may still be loading after the navigation), and ignores one
 * that waited too long: a late, unexpected find bar would be a surprise.
 */
export interface ConversationFindRequest {
  featureId: number;
  query: string;
  nonce: number;
  at: number;
}

const REQUEST_TTL_MS = 15_000;

interface ConversationFindRequestState {
  request: ConversationFindRequest | null;
}

export const useConversationFindRequestStore = create<ConversationFindRequestState>(() => ({
  request: null,
}));

let nextNonce = 1;

export function requestConversationFind(featureId: number, query: string): void {
  useConversationFindRequestStore.setState({
    request: { featureId, query, nonce: nextNonce++, at: Date.now() },
  });
}

/** Clears the request once taken (only that one: a newer request stays). */
export function takeConversationFind(nonce: number): void {
  useConversationFindRequestStore.setState((state) =>
    state.request?.nonce === nonce ? { request: null } : state,
  );
}

export function isFreshFindRequest(request: ConversationFindRequest, now: number): boolean {
  return now - request.at <= REQUEST_TTL_MS;
}
