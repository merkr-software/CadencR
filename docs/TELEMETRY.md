# Privacy and telemetry

CadencR remains local-first. **Diagnostics and usage analytics are separate opt-ins,
both off by default.** Open **Settings → About Cadencr → Privacy and telemetry**
to change them, inspect the payload examples and delivery status, or reset the
random installation identity. Existing installations also start with both off.

Starting with v0.16.0, existing installations must make an explicit decision
about detailed telemetry on first launch. New installations make the same decision
during onboarding; skipping onboarding still requires that step. Enable diagnostics
& usage, Customize, and Decline detailed telemetry are available, and declining
permits normal use. A separate
persisted decision marker distinguishes a recorded refusal from preferences
that have never been presented. Later launches do not ask again after a saved
decision. Identity resets preserve the decision.

The independent **monthly audience counter** defaults on when PostHog is
configured and runs even before the detailed telemetry decision is saved.
Accepting or declining detailed telemetry leaves the counter's existing setting
unchanged. Customize exposes only diagnostics and detailed usage analytics;
the counter has its own switch in **Settings → About → Privacy and telemetry**.
All three settings remain available there. No detailed telemetry decision is
inferred from a missing preference, a monthly count, or skipping onboarding.
Detailed decisions update only their two options, preserving the current counter
setting even if it changed while the decision was open.

The Rust service owns category preferences and all remote delivery. The renderer
and Electron main pass only validated diagnostics to that service. Missing or
invalid configuration means no delivery for that category, even when enabled.

## Data sent

| Category         | Destination | Allowlisted data                                                                                                                                                                                          |
| ---------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagnostics      | Sentry      | Fixed failure category, timestamp and event ID, random installation ID, release, OS family, architecture, process, schema version; optional packaged app frame filename/line/column and renderer build ID |
| Usage analytics  | PostHog     | Fixed event name, timestamp, random installation ID, release, OS family, architecture, process and schema version; `turn_completed` also has fixed outcome, provider, actor and duration bucket values    |
| Monthly audience | PostHog     | One `active_installation_monthly` event per UTC calendar month and installation, with a fresh event-only distinct ID and privacy controls; no persistent installation ID or other app metadata            |

The installation ID is pseudonymous, not an account identity. It is created
locally when diagnostics or detailed usage is first enabled and persists in global settings.
Resetting it changes future events; it does not delete events already held by a
vendor. Switching a category off stops future delivery. Pending events are
discarded and in-flight requests are cancelled; a request already received by a
vendor cannot be recalled.

Remote payloads exclude prompts, completions, your code, conversation text or IDs,
project names or paths, Git remotes, terminal output, tool arguments, credentials,
raw errors, arbitrary properties, breadcrumbs, log dumps and session replay.
There is no automatic click/page capture, tracing, profiling, person-profile
creation, feature-flag fetching or replay integration. Payloads disable PostHog
geolocation and replace IP fields with `0.0.0.0`; vendors still receive the
network connection and can process its source IP under their own policies.

### Minimal monthly audience measurement

The local desktop calls the local service activity endpoint while in use. The
service checks the independent audience switch and durably claims the current
UTC month before making a single bounded HTTP attempt directly to PostHog. It
stores only the last claimed month for this counter, with no identifier used
across months or shared with diagnostics and detailed analytics. The PostHog API
requires a `distinct_id`; this channel generates a fresh random value for each
attempt and disables person profiles and geolocation. There is no relay or
additional hosting requirement, and no cookieless fingerprinting SDK.

In PostHog, create a Trends insight for `active_installation_monthly`, aggregate
by **Total count**, and group by calendar month using **UTC** as the chart/project
timezone, matching the local month claim. This estimates active
installations, not unique people, retention, or a rolling 30-day user count.
Reinstalls and multiple computers may count more than once. Offline operation,
blocked requests, process termination and failed attempts can undercount; the
client deliberately does not retry a claimed month. PostHog uses receipt time,
so network delays across a UTC month boundary can also shift a count to the next
month. Identity reset, disabling
and re-enabling, or restarting do not create a second attempt for that month.
Delivery failure is a current-process status; after a restart, Ready indicates
configuration, not proof that the month's event arrived.

PostHog receives individual network connections for this channel. Suppressing
IP fields and geolocation does not hide the source IP from its infrastructure.
This implementation does not establish a consent exemption: before distributing
a build with this counter enabled by default, assess the applicable audience
measurement exemption, vendor processing and retention, and relevant countries.
See the [CNIL audience measurement criteria](https://www.cnil.fr/fr/cookies-solutions-pour-les-outils-de-mesure-daudience).
The app explains the counter and lets users disable it at any time.

### Usage event allowlist

| Event                  | Trigger                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_session_started`  | Once per service run after usage consent is enabled                                                                                                                    |
| `project_added`        | A project is successfully added                                                                                                                                        |
| `provider_ready`       | First provider catalog response with an available provider after opting in, once per service run                                                                       |
| `first_turn_completed` | First successful turn after enabling usage, once per installation identity                                                                                             |
| `turn_completed`       | Turn ends; `outcome` is `completed`, `failed` or `interrupted`; provider is a built-in registry identifier or `custom`, actor is `unknown`, duration is a fixed bucket |

Turn duration buckets are `under_one_second`, `under_ten_seconds`,
`under_one_minute`, `under_five_minutes` and `five_minutes_or_more`. Actor remains
`unknown` in this MVP; human and agent turns cannot be distinguished.

These events support opted-in active-installation counts, project/provider/first
turn activation, and turn outcomes. They do not measure all users, historical
activity, model choice, tokens, cost, prompts or individual feature clicks.

### Diagnostic category allowlist

- Renderer: `react_boundary`, `renderer_unhandled_error`,
  `renderer_unhandled_rejection`, `renderer_recoverable`.
- Electron: `electron_main` and `renderer_process_exit`. The accepted
  `electron_preload` and `service_process_exit` categories have no capture hooks
  in this MVP.
- Service: `service_internal`, `service_database`, `service_git`, `service_panic`.

The category replaces the raw exception message. JavaScript frames retain only
packaged `assets/<bundle>.js`, `main/index.js` or `preload/index.js` with numeric
positions. Frames from user files, URLs, custom tabs and provider output are
excluded. Curated service panic locations refer only to CadencR source. Local browser-only development reports send no stack frames because they lack
the trusted packaged bundle manifest. Paired remote devices cannot read or
change consent or ingest diagnostics; manage telemetry on the host desktop.
Host consent still governs service-side usage events from operations initiated
remotely. Electron main capture is best effort through its uncaught
exception monitor; startup and service-down recovery remain local.

## Delivery and limits

- For diagnostics and detailed usage, a bounded memory queue holds at most 32 events; there is no disk backlog or
  retry loop. Queued events expire after 30 seconds. Events can be dropped under load, offline, on process exit or after
  opt-out. Each HTTP attempt has a three-second timeout.
- Per service run: at most 20 diagnostics and 200 usage events. Per minute: at
  most five diagnostics and 30 usage events. Restarting resets these limits;
  these are local volume guards, not organization-wide billing guarantees.
- Settings reports disabled, not configured, ready or delivery failed for each
  category. Ready means configured and enabled, not confirmed vendor ingestion.
- No native crash handler, minidumps, core dumps or native symbol uploads are
  installed. A killed process, blocked event loop or service failure may prevent
  capture. If the service is unavailable, Electron cannot upload through it.
- Existing local diagnostic reports are separate. They can include raw error
  text and remain local until manually shared; they are never uploaded as a
  telemetry payload. See [renderer diagnostics](./RENDERER_DIAGNOSTICS.md).

## Configure your existing free projects

No CadencR account or subscription is required. Maintainers supply their own
Sentry and PostHog projects; users choose detailed telemetry consent and can
disable the independent monthly counter in the app.

| Service                                                  | Free-tier setup for an initial group of about 20 users                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Sentry Developer](https://sentry.io/pricing/)           | Select the free Developer plan: one organization member and 5,000 errors/month. App installations do not consume member seats. Keep paid billing disabled. [Developer has no pay-as-you-go budget](https://www.sentry.help/en/articles/13965037-can-i-set-up-an-on-demand-pay-as-you-go-budget-for-my-free-developer-plan). |
| [PostHog Product Analytics](https://posthog.com/pricing) | One million events/month free. Use the free plan without a card, or set the product billing limit to `$0`. Do not enable replay or other paid products for this integration.                                                                                                                                                |

Plan limits can change; confirm them in the vendor account before shipping.
CadencR cannot change or guarantee those external billing settings. Watch quotas
during the first weeks; repeated restarts or errors can still exhaust an allowance.

### Ingest configuration

Copy the Sentry project's **public DSN** and the PostHog **Project API key**
(`phc_…`, not a personal or secret API key). Use an EU PostHog project with
[`https://eu.i.posthog.com`](https://posthog.com/docs/api) as its ingest host.

| Variable                        | Purpose                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CADENCR_SENTRY_DSN`            | Public Sentry ingest DSN; omit to disable diagnostic delivery                                             |
| `CADENCR_POSTHOG_KEY`           | Public PostHog project key; omit to disable detailed usage and monthly audience delivery                  |
| `CADENCR_POSTHOG_HOST`          | HTTPS PostHog ingest origin; defaults to `https://eu.i.posthog.com`                                       |
| `CADENCR_TELEMETRY_DEV_ENABLED` | Debug builds require the exact value `true`, in addition to category preferences and ingest configuration |

The service reads runtime environment values first and falls back to values
embedded during its Rust build. Set the three `CADENCR_*` ingest values as GitHub
repository **variables** for both desktop release workflows; they are public
ingest configuration, not administrative credentials. Empty values leave the
corresponding integration unconfigured. No ingest variables are needed in the
renderer or Electron bundles. The monthly counter uses the same PostHog key and
host; it needs no extra GitHub variable, secret, or hosted server.

For packaged local builds, `pnpm build:local` (or `pnpm build:local:linux`) fetches
these three values and the marketplace configuration from GitHub using `gh`,
validates them, then embeds the ingest configuration during compilation. All
three ingest values are required when a configuration is available. If `gh` is
absent, GitHub cannot be reached, access is denied, or no build variables are
configured, the command falls back to a build without managed marketplace or
telemetry configuration (including the monthly counter). Inherited build values
are cleared in this mode. A partial or malformed fetched configuration is rejected.
Run `pnpm build:local --check-config` to validate without compiling. See
[Packaged local builds](../CONTRIBUTING.md#packaged-local-builds) for prerequisites.

For a local development check, put values in the uncommitted service `.env`:

```dotenv
CADENCR_SENTRY_DSN=https://PUBLIC_KEY@YOUR_INGEST_HOST/PROJECT_ID
CADENCR_POSTHOG_KEY=phc_YOUR_PROJECT_KEY
CADENCR_POSTHOG_HOST=https://eu.i.posthog.com
CADENCR_TELEMETRY_DEV_ENABLED=true
```

Restart `pnpm dev`, enable only the category you are checking, then perform an
allowlisted action. Inspect the vendor's event JSON for the expected fields and
the app's delivery status. Tests can use loopback receivers with the additional
debug-only `CADENCR_TELEMETRY_ALLOW_LOCAL_TESTING=1`; release builds require HTTPS.

## Renderer source maps and release correlation

Events use release `cadencr@<app version>` and a `process` tag. Renderer diagnostics
also set Sentry `dist` to the exact renderer `buildId`, matching the retained
renderer build metadata. The existing release workflows retain the exact
renderer bundles and hidden maps in separate public diagnostics archives; maps
remain excluded from packaged renderer resources.

To opt into automatic Sentry renderer uploads, configure:

| GitHub configuration       | Value                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Secret `SENTRY_AUTH_TOKEN` | CI upload token with `org:ci` or `project:releases` scope; never embed it in the app         |
| Variable `SENTRY_ORG`      | Sentry organization slug                                                                     |
| Variable `SENTRY_PROJECT`  | Project slug matching the ingest DSN                                                         |
| Variable `SENTRY_URL`      | Your Sentry Cloud regional API origin, e.g. `https://de.sentry.io` or `https://us.sentry.io` |

When the secret is absent, uploads are skipped. When present, incomplete
configuration or an upload failure fails that workflow step visibly. The script
uses Sentry's documented [release creation](https://docs.sentry.io/api/releases/create-a-new-release-for-an-organization/)
and [release file upload](https://docs.sentry.io/api/releases/upload-a-new-organization-release-file/)
APIs after archival, before packaging. It uploads the existing bytes without
injecting IDs or rebuilding, associates hidden maps through a `Sourcemap` header,
and uses `~/assets/<bundle>.js` to match event frames `app:///assets/<bundle>.js`.
Precompiled workers without maps are uploaded as JavaScript only and reported
in `unmapped`, without a fabricated `Sourcemap` header. Renderer entry maps
remain required, and every present map is validated before any upload.
Reruns skip identical name/distribution/checksum artifacts; conflicts fail without
overwriting or deleting existing files.

The release workflows load this standalone uploader from their immutable
workflow commit before the step receives its Sentry upload token. This lets a
reviewed workflow fix resume publication while the application checkout remains
pinned to its original release tag.

Run the same uploader manually against an existing build with the four Sentry
upload variables in the environment:

```sh
node scripts/upload-sentry-renderer-maps.mjs
```

Verify release, `dist` and bundle name against `build-info.json` before trusting
symbolication. End-to-end Sentry symbolication requires a configured real project
and a controlled error in that exact packaged build. This MVP uploads renderer
maps only; Electron main/preload and Rust native symbols are not generated or
uploaded by this workflow.
