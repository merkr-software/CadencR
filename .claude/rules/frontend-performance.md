---
paths:
  - "packages/desktop/src/**"
---

This is an IDE; users expect IDE-level responsiveness. Treat a perf regression on a hot path (agent stream, terminal, editor, long lists) as a correctness bug.

- **Always select from Zustand stores.** `useFooStore()` with no selector subscribes the consumer to every mutation, on every session. Select the slice you read — `useFooStore((s) => s.fieldA)` — and reach for `useFooStore.getState()` for actions that shouldn't drive renders.
- **Stabilize hook return values.** A hook that returns a fresh object literal each render breaks every downstream `useMemo` and `React.memo`. Wrap the return in `useMemo`, or split state and actions into separate hooks.
- **`React.memo` hot-path components** and keep their props stable (`useCallback` for callbacks, `useMemo` for objects/arrays). Anything mounted next to a streaming source or kept alive in a hidden tab qualifies.
- **Virtualize any list whose size scales with user data** — chat, logs, file trees, diff lists — with `react-virtuoso` or `@tanstack/react-virtual`.
- **Bound main-thread work.** Cache, gate by viewport, or offload synchronous parsing, highlighting, and markdown rendering at mount. Code-split heavy modules (CodeMirror, grammars, decoders) behind dynamic `import()` or `React.lazy`.
- **Gate layout reads** (`scrollHeight`, `getBoundingClientRect`) — never on every render or every resize event.

- **A conversation workspace outlives its time on screen.** The `ws-session` page keeps recent workspaces mounted and hidden (`WorkspacePool`, `docs/adr/0003-conversation-workspaces-stay-mounted.md`), mounts a pressed sidebar row's workspace hidden before the click (dropped after about two seconds without one, at the next idle period), and closes a hidden workspace's side and plugin tabs after 30 s unless its editor holds unsaved work. Anything in one that acts outside its own DOM — a shortcut, a global listener, a relayed browser shortcut, a native view, a backend subscription, a poll, a navigation — must stand down while `useWorkspaceActivity()` says it is hidden: read `isActive()` at event time, wrap a lifecycle in `whileActive()`, give a poll `useSettledWorkspaceActive()`; showing or hiding must re-render nothing in it in the commit that switches (slow consumers follow in a transition), and viewport observers keep their last state while it is hidden. A tab request (`focusTab`) is applied by the pool on each activation, not by a remount, and nothing above the pool may count on a remount when the conversation changes; navigate from a conversation with `navigateToConversation()` so the page (and its pool) stays mounted.

Before adding a tab, panel, or component under the agent/editor/terminal area, check how often it re-renders during streaming.
