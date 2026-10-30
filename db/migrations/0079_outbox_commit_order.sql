-- Consume the outbox in commit order, not id order. Ids are assigned at
-- INSERT, so an event whose transaction commits late can sit below a cursor
-- that already moved past it and be skipped forever (HANDOVER: "outbox
-- consumption by commit order instead of id"). Each row records the id of
-- the transaction that wrote it; a consumer only reads rows whose
-- transaction is older than every transaction still running
-- (pg_snapshot_xmin), in (txid, id) order. Numbered past ADR-0005's 0054-0056.
ALTER TABLE outbox_events ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX idx_outbox_events_txid_id ON outbox_events (txid, id);

-- The cursor becomes the pair (txid, id). Every row that existed before this
-- migration was stamped with this migration's own txid, so an existing
-- consumer resumes at (this txid, its last id).
ALTER TABLE reporting_outbox_cursor
    ADD COLUMN last_processed_txid xid8 NOT NULL DEFAULT '0'::xid8;
UPDATE reporting_outbox_cursor SET last_processed_txid = pg_current_xact_id();
