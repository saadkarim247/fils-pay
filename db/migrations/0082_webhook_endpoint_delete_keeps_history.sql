-- Deleting a webhook endpoint keeps its delivery history and archives with
-- endpoint_id set to NULL (what webhooks/cancel.ts documents). Both foreign
-- keys were NO ACTION on NOT NULL columns (the "ON DELETE SET NULL (0029)"
-- comment is wrong: 0029 is a payment-links index), so deleting any endpoint
-- that had ever received a delivery failed with a 500. Every reader joins
-- deliveries to their endpoint, so detached rows drop out of live views and
-- the dispatcher. Numbered past ADR-0005's 0054-0056.
ALTER TABLE webhook_deliveries ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_endpoint_id_fkey;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_endpoint_id_fkey
    FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE SET NULL;

ALTER TABLE webhook_delivery_archives ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE webhook_delivery_archives DROP CONSTRAINT webhook_delivery_archives_endpoint_id_fkey;
ALTER TABLE webhook_delivery_archives ADD CONSTRAINT webhook_delivery_archives_endpoint_id_fkey
    FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE SET NULL;
