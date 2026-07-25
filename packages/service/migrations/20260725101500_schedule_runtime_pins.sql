-- Everything the composer can set, a schedule can pin.
--
-- The schedules table shipped with the runtime options the model picker owns
-- (provider / model / thinking level) but not the ones that live in the rest of
-- the chip row: the collaboration mode, the provider access mode, and the
-- Claude profile. A scheduled run is an ordinary prompt sent later, so it has
-- to be able to say "run this nightly sweep in plan mode, read-only" — which
-- means storing those three next to the others.
--
-- All three stay nullable and unconstrained. NULL means "resolve what a session
-- started by hand would resolve", and the accepted values are a per-provider
-- catalog that grows without a schema change (see `provider_supports_mode` and
-- `parse_access_mode_wire`); a CHECK here would turn adding a provider mode
-- into a migration.
ALTER TABLE schedules ADD COLUMN permission_mode TEXT;
ALTER TABLE schedules ADD COLUMN access_mode TEXT;
ALTER TABLE schedules ADD COLUMN profile TEXT;

-- Never read, never written. Conversations created by a schedule keep the
-- `Session N` placeholder so the ordinary auto-namer titles them from the
-- prompt, exactly as it does for one started from the New button — a
-- hand-written template was a second, worse naming system.
ALTER TABLE schedules DROP COLUMN title_template;
