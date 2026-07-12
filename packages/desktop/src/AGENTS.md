<!-- auto-generated from .claude/rules/ — edit those files and run pnpm build:agents-md -->

# AGENTS.md

These rules apply to frontend source under `packages/desktop/src/`.

### explicit-state
_Applies to: `**/*.tsx`, `**/*.ts`_

Every async operation must have visible loading state. If the app is loading, fetching, or processing, the user must see a loader, skeleton, or progress indicator. Users should never stare at a seemingly frozen screen. An unacknowledged wait is a UX bug.

### frontend-performance
_Applies to: `packages/desktop/src/**`_

These rules apply to frontend code under `packages/desktop/src/`. The app is an IDE; technical users expect IDE-level responsiveness. Performance is a hard constraint, not an afterthought — think about render cost, subscription scope, main-thread work, and redundant network calls *before* writing the change.

#### Mandatory practices

- **Always select from Zustand stores.** Never call a store hook without a selector (`useFooStore()` subscribes the consumer to every mutation, on every session). Always select the slice you actually read: `useFooStore((s) => s.fieldA)`. Read actions outside the render flow via `useFooStore.getState()` when they don't need to drive UI updates.
- **Stabilize hook return values.** A custom hook that returns a fresh object literal each render breaks every downstream `useMemo` and `React.memo`. Wrap the return in `useMemo` keyed on the primitive fields it depends on, or split state and actions into separate hooks.
- **`React.memo` hot-path components.** Anything mounted next to a streaming source (agent stream, terminal, editor, long list) or kept alive in a hidden tab must be memoized. Verify props are stable — callbacks via `useCallback`, objects/arrays via `useMemo`.
- **Virtualize long lists.** Rendering hundreds of DOM nodes for a chat, log, file tree, or diff list is a bug. Use `react-virtuoso` or `@tanstack/react-virtual`. The agent stream, file trees, search results, and any list whose size scales with user data must be windowed.
- **Bound main-thread work.** Synchronous parsing, syntax highlighting, or markdown rendering at mount must be cached, gated by viewport, or offloaded (`requestIdleCallback`, Web Worker). No unbounded synchronous work on first paint.
- **Lazy-load heavy modules.** Editors (CodeMirror), syntax-highlighting grammars, image/video decoders, and any module > 100 KB gzipped must be code-split via dynamic `import()` or `React.lazy`.

#### Forbidden patterns

- Subscribing a hot component to an entire store (no selector), or returning the raw store from a wrapper hook.
- Returning a fresh object literal from a custom hook without `useMemo`.
- Passing freshly-built objects, arrays, or arrow functions as props through a streaming or list-rendering parent — they defeat memoization on every descendant.
- Adding a new tab, panel, or component under the agent/editor/terminal area without auditing how often it re-renders during streaming.
- Running heavy computation inside the render body. Move it to `useMemo`, an effect, or off-thread.
- Triggering layout reads (`scrollHeight`, `getBoundingClientRect`, etc.) on every render or every resize event without gating.

When in doubt, profile first. Don't speculate; don't ignore. A perf regression on a hot path is treated like a correctness bug.

### keyboard-shortcuts
_Applies to: `**/*.tsx`_

When adding a new user-facing feature, ask whether it needs a keyboard shortcut. Power users rely on keyboard navigation — don't ship a feature that can only be triggered by mouse if it could reasonably have a keybinding.

### no-optimistic-updates
_Applies to: `packages/desktop/src/**`_

Do NOT use optimistic updates in the frontend. Everything runs locally — there is no latency to hide. Optimistic updates create multiple sources of truth and add unnecessary complexity.

The Zustand store state must be the single source of truth. Only update store state when the backend confirms a change via WebSocket events. Never set state optimistically in action dispatchers (e.g., don't set status in `startPlan()`, `approvePlan()`, etc. — wait for the backend WebSocket event).

Session/agent status has exactly one canonical source: `useSessionStatusStore` (`@/stores/session-status-store`), populated only by the backend `session_status.update` / `session_status.snapshot` envelopes (`LiveAgentStatus`: `"idle" | "agent" | "question"`). Read "is the agent working?" from there — never re-derive or track it separately.

### provider-boundaries
_Applies to: `packages/service/src/**`, `packages/desktop/src/**`, `packages/*-sdk-rs/src/**`_

Do not scatter provider-specific logic across shared codepaths.

- Provider SDKs are only for provider communication details.
- Provider adapters are where provider-specific business logic should live on the backend.
- Shared backend runtime, workflow, and API code should consume unified adapter interfaces and provider-neutral types.
- Shared frontend components, hooks, and stores should consume provider-neutral catalog/config data instead of hardcoded provider branches.
- If a provider needs special handling, extract it into a dedicated provider file or folder rather than adding another provider-specific conditional in generic code.

### strict-typing
_Applies to: `**/*.ts`, `**/*.tsx`_

Never use `any` — use `unknown` and narrow with type guards; prefer explicit types and Zod schemas at boundaries.
(enforced by oxlint `typescript/no-explicit-any` — see .oxlintrc.json.)
