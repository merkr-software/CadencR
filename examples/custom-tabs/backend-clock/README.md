# Backend clock

A protocol-v2 native backend publishes an opaque `clock.tick` topic from a
background thread. The guest subscribes before `start`, renders the process
identity and counter, and requests `snapshot` after a resync. No API scope is
needed beyond explicit consent to the native backend.

This example uses the unreleased SDK in this checkout. From the repository root:

```bash
pnpm rust -- build -p cadencr-tab-backend --example clock
mkdir -p examples/custom-tabs/backend-clock/bin
cp target/debug/examples/clock examples/custom-tabs/backend-clock/bin/clock
pnpm --filter @cadencr/desktop exec tsc --project ../../examples/custom-tabs/backend-clock/tsconfig.json
pnpm --filter @cadencr/desktop exec vite build --config ../../examples/custom-tabs/backend-clock/vite.config.ts
```

The built binary is for the current platform only. Copy this folder's
`tab.json`, `dist/` and `bin/` to the local plugins directory, approve the native
code consent, enable it for a project and open its Clock tab in a conversation.
Use **Read snapshot**, **Unsubscribe**, or stop the backend from **Activity**.
Stopping yields a visible error and resync. A subsequent explicit `start`
request recreates the process; the subscription follows it without replaying
any method. Reopening the guest also registers a fresh subscription.

The Rust producer lives at
`packages/tab-backend-sdk-rs/examples/clock.rs`. Keep `backend.protocol: 2`;
older hosts refuse this manifest rather than pretending to stream.
