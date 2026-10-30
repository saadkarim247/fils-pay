-- Webhook delivery archives in pages of 1000 deliveries, as ADMIN.md
-- documents ("so any range is fine"). Capture and restore used to hold the
-- whole range in memory as one JSON value in archive_payload. New archives
-- store '[]' there and their entries here, in capture order; archives taken
-- before this migration keep archive_payload and still restore from it.
-- Numbered past ADR-0005's 0054-0056.
CREATE TABLE webhook_delivery_archive_pages (
    archive_id  UUID    NOT NULL REFERENCES webhook_delivery_archives (id) ON DELETE CASCADE,
    page_no     INTEGER NOT NULL,
    entries     TEXT    NOT NULL,
    PRIMARY KEY (archive_id, page_no)
);
