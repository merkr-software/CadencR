# Frontend session state has a single writer fed only by backend events

Live status, turn lifecycle and pending gates live in one desktop module keyed
by feature, with live status indexed by session. Both sockets and request
acknowledgements feed it through one pure reducer; user actions only send
requests and wait for their acknowledgement. "Is an agent working?" is always
answered from live status, so power, app-close and Stop-all consider every
session, not only conversations opened on this device.

## Considered options

Keeping two stores synchronised by cross-writes left three writers per turn and
let local optimism contradict other devices. Moving the transcript into the same
module was deferred: it is the streaming hot path, and block identity changes
there have caused renderer memory regressions.
