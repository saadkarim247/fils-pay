-- One note per acquirer callback (FP-201). Acquirers redeliver callbacks;
-- nothing de-duplicated them (the processed_events table HANDOVER describes
-- does not exist), so every redelivery added another copy of the same
-- verdict. Existing redundant copies are removed, keeping the first one
-- received, so the unique index can be built. Numbered past ADR-0005's
-- reserved 0054-0056.
DELETE FROM acquirer_callback_notes n
 USING acquirer_callback_notes keep
 WHERE n.callback_id = keep.callback_id
   AND (keep.created_at, keep.id::text) < (n.created_at, n.id::text);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
