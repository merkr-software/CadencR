// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { usePromptStashStore } from "./prompt-stash-store";

describe("usePromptStashStore", () => {
  beforeEach(() => {
    localStorage.clear();
    usePromptStashStore.setState({ byProject: {} });
  });

  it("keeps the ten newest drafts per project, newest first, across reloads", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < 12; index += 1) store.push(1, `draft ${index}`);
    const drafts = usePromptStashStore.getState().byProject[1];
    expect(drafts).toHaveLength(10);
    expect(drafts[0].text).toBe("draft 11");
    usePromptStashStore.setState({ byProject: {} });
    expect(usePromptStashStore.getState().load(1)[0].text).toBe("draft 11");
    expect(usePromptStashStore.getState().load(2)).toEqual([]);
  });

  it("removes one draft by its stash time", () => {
    usePromptStashStore.getState().push(3, "a");
    const [draft] = usePromptStashStore.getState().byProject[3];
    usePromptStashStore.getState().remove(3, draft.stashedAt);
    expect(usePromptStashStore.getState().byProject[3]).toEqual([]);
  });
});
