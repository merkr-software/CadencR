---
paths:
  - "packages/desktop/src/**"
---

These rules apply to frontend code under `packages/desktop/src/`. The app is an IDE; technical users expect IDE-level responsiveness. Performance is a hard constraint, not an afterthought — think about render cost, subscription scope, main-thread work, and redundant network calls *before* writing the change.

### Mandatory practices

- **Always select from Zustand stores.** Never call a store hook without a selector (`useFooStore()` subscribes the consumer to every mutation, on every session). Always select the slice you actually read: `useFooStore((s) => s.fieldA)`. Read actions outside the render flow via `useFooStore.getState()` when they don't need to drive UI updates.
- **Stabilize hook return values.** A custom hook that returns a fresh object literal each render breaks every downstream `useMemo` and `React.memo`. Wrap the return in `useMemo` keyed on the primitive fields it depends on, or split state and actions into separate hooks.
- **`React.memo` hot-path components.** Anything mounted next to a streaming source (agent stream, terminal, editor, long list) or kept alive in a hidden tab must be memoized. Verify props are stable — callbacks via `useCallback`, objects/arrays via `useMemo`.
- **Virtualize long lists.** Rendering hundreds of DOM nodes for a chat, log, file tree, or diff list is a bug. Use `react-virtuoso` or `@tanstack/react-virtual`. The agent stream, file trees, search results, and any list whose size scales with user data must be windowed.
- **Bound main-thread work.** Synchronous parsing, syntax highlighting, or markdown rendering at mount must be cached, gated by viewport, or offloaded (`requestIdleCallback`, Web Worker). No unbounded synchronous work on first paint.
- **Lazy-load heavy modules.** Editors (CodeMirror), syntax-highlighting grammars, image/video decoders, and any module > 100 KB gzipped must be code-split via dynamic `import()` or `React.lazy`.

### Forbidden patterns

- Subscribing a hot component to an entire store (no selector), or returning the raw store from a wrapper hook.
- Returning a fresh object literal from a custom hook without `useMemo`.
- Passing freshly-built objects, arrays, or arrow functions as props through a streaming or list-rendering parent — they defeat memoization on every descendant.
- Adding a new tab, panel, or component under the agent/editor/terminal area without auditing how often it re-renders during streaming.
- Running heavy computation inside the render body. Move it to `useMemo`, an effect, or off-thread.
- Triggering layout reads (`scrollHeight`, `getBoundingClientRect`, etc.) on every render or every resize event without gating.

When in doubt, profile first. Don't speculate; don't ignore. A perf regression on a hot path is treated like a correctness bug.
