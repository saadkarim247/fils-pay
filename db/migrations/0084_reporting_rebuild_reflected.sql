-- Outbox events the admin "Rebuild analytics" already counted from the
-- source tables, so the reporting worker skips them instead of counting them
-- twice. The rebuild sets the worker's cursor to its snapshot's oldest
-- still-running transaction and lists here the (few) events above that point
-- that its snapshot could already see. Rebuilt on every admin rebuild,
-- cleared when the cursor is reset. Numbered past ADR-0005's 0054-0056.
CREATE TABLE reporting_rebuild_reflected (
    consumer_name TEXT   NOT NULL,
    event_id      BIGINT NOT NULL,
    PRIMARY KEY (consumer_name, event_id)
);
