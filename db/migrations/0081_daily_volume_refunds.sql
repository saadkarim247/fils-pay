-- Refunds in the dashboard's daily rollup (FP-300: "shows up right in the
-- reports"). The reporting worker now consumes refund.succeeded into these
-- columns, keyed by the Bahrain business day like captures. No backfill:
-- refunds returned 501 until FP-300, so production has no refund history;
-- anywhere refunds ran earlier, `reporting rebuild` replays them.
-- Numbered past ADR-0005's 0054-0056.
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;
