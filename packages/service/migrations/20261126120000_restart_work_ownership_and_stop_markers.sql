-- A reader can release only its own work, even after its runtime is replaced.
-- Rows left by an older service still take part in startup recovery.
ALTER TABLE agent_background_work ADD COLUMN reader_id TEXT;

-- A user Stop is durable before its reader appends the transcript marker.
-- NULL identifies older Stops so startup can check their transcripts once.
ALTER TABLE agent_user_stops
    ADD COLUMN marker_pending INTEGER CHECK (marker_pending IN (0, 1));
