// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendComposerContext,
  composerKeyFor,
  useComposerContextStore,
  type ComposerContextItem,
} from "./composer-context-store";

const item = (overrides: Partial<ComposerContextItem>): ComposerContextItem => ({
  id: "1",
  kind: "pasted",
  label: "Pasted text",
  content: "x",
  ...overrides,
});

describe("appendComposerContext", () => {
  it("returns the text untouched when there is no context", () => {
    expect(appendComposerContext("hello", [])).toBe("hello");
  });

  it("fences code-like context under a heading, after the user's words", () => {
    const text = appendComposerContext("Why?", [
      item({
        kind: "selection",
        label: "src/a.ts",
        detail: "lines 2–4",
        content: "a()",
        language: "ts",
      }),
    ]);
    expect(text).toBe("Why?\n\n**src/a.ts — lines 2–4**\n```ts\na()\n```");
  });

  it("widens the fence when the content itself contains one", () => {
    const text = appendComposerContext("", [item({ content: "```js\nx\n```" })]);
    expect(text.startsWith("**Pasted text**\n````\n")).toBe(true);
    expect(text.endsWith("\n````")).toBe(true);
  });

  it("keeps pull requests and reviews as prose", () => {
    const text = appendComposerContext("Review", [
      item({ kind: "pull_request", label: "Pull request #4", detail: "Fix", content: "Fix\nurl" }),
    ]);
    expect(text).toBe("Review\n\n**Pull request #4 — Fix**\nFix\nurl");
  });
});

describe("useComposerContextStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useComposerContextStore.setState({ items: {} });
  });

  it("adds and removes per composer, mirrored to localStorage", () => {
    const key = composerKeyFor(7);
    const store = useComposerContextStore.getState();
    store.add(key, { kind: "terminal", label: "Terminal output", content: "ls" });
    const [added] = useComposerContextStore.getState().items[key];
    expect(added.label).toBe("Terminal output");
    expect(localStorage.getItem(`cadencr:composer-context:${key}`)).toContain("Terminal output");
    useComposerContextStore.getState().remove(key, added.id);
    expect(useComposerContextStore.getState().items[key]).toEqual([]);
    expect(localStorage.getItem(`cadencr:composer-context:${key}`)).toBeNull();
  });

  it("removes only the given items, keeping one added meanwhile", () => {
    const key = composerKeyFor(7);
    const store = useComposerContextStore.getState();
    store.add(key, { kind: "pasted", label: "A", content: "a" });
    store.add(key, { kind: "pasted", label: "B", content: "b" });
    const [a, b] = useComposerContextStore.getState().items[key];
    store.add(key, { kind: "pasted", label: "C", content: "c" });
    store.remove(key, a.id, b.id);
    expect(useComposerContextStore.getState().items[key].map((i) => i.label)).toEqual(["C"]);
  });

  it("hydrates from localStorage once, then keeps the store's copy", () => {
    const key = composerKeyFor(8);
    localStorage.setItem(
      `cadencr:composer-context:${key}`,
      JSON.stringify([{ id: "x", kind: "review", label: "R", content: "r", commentIds: [3] }]),
    );
    const store = useComposerContextStore.getState();
    store.hydrate(key);
    expect(useComposerContextStore.getState().items[key][0].commentIds).toEqual([3]);
    localStorage.removeItem(`cadencr:composer-context:${key}`);
    store.hydrate(key);
    expect(useComposerContextStore.getState().items[key]).toHaveLength(1);
  });
});
