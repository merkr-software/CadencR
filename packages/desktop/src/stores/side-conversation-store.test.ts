// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useSideConversationStore } from "./side-conversation-store";

const question = (featureId: number) => ({
  featureId,
  sessionId: featureId + 100,
  projectId: 1,
  question: `question ${featureId}`,
});

describe("useSideConversationStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSideConversationStore.setState({ bySource: {} });
  });

  it("keeps a conversation's side questions in order, across reloads", () => {
    const store = useSideConversationStore.getState();
    store.add(7, question(1));
    store.add(7, question(2));
    store.add(8, question(3));
    useSideConversationStore.setState({ bySource: {} });
    expect(useSideConversationStore.getState().load(7)).toEqual([question(1), question(2)]);
    expect(useSideConversationStore.getState().load(8)).toEqual([question(3)]);
  });

  it("forgets one once kept or closed, and the storage key with the last", () => {
    const store = useSideConversationStore.getState();
    store.add(7, question(1));
    store.add(7, question(2));
    store.remove(7, 1);
    expect(useSideConversationStore.getState().bySource[7]).toEqual([question(2)]);
    store.remove(7, 2);
    expect(localStorage.getItem("cadencr:side-conversations:7")).toBeNull();
  });
});
