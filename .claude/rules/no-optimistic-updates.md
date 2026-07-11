---
paths:
  - "packages/desktop/src/**"
---

Do NOT use optimistic updates in the frontend. Everything runs locally — there is no latency to hide. Optimistic updates create multiple sources of truth and add unnecessary complexity.

The Zustand store state must be the single source of truth. Only update store state when the backend confirms a change via WebSocket events. Never set state optimistically in action dispatchers (e.g., don't set status in `startPlan()`, `approvePlan()`, etc. — wait for the backend WebSocket event).

Session/agent status has exactly one canonical source: `useSessionStatusStore` (`@/stores/session-status-store`), populated only by the backend `session_status.update` / `session_status.snapshot` envelopes (`LiveAgentStatus`: `"idle" | "agent" | "question"`). Read "is the agent working?" from there — never re-derive or track it separately.
