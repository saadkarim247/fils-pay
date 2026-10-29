-- 0072's view joined transactions ON t.id = r.id (a refund id is never a
-- transaction id), so it was always empty; it also summed the sale's
-- captured amount once per refund, double-counting a sale refunded in parts.
-- Recreated with the right join and the captured amount counted once per
-- sale per day. Refreshed by the reporting worker on settlement.batch_closed.
-- Numbered past ADR-0005's reserved 0054-0056.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT per_sale.merchant_id,
       per_sale.business_date,
       SUM(per_sale.refund_count)       AS refund_count,
       SUM(per_sale.refunded_fils)      AS total_refunded_fils,
       SUM(per_sale.fee_reversed_fils)  AS total_fee_reversed_fils,
       SUM(per_sale.captured_fils)      AS original_captured_fils
  FROM (
        SELECT r.merchant_id,
               date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
               r.transaction_id,
               COUNT(*)                AS refund_count,
               SUM(r.amount_fils)      AS refunded_fils,
               SUM(r.fee_reversed_fils) AS fee_reversed_fils,
               MAX(t.captured_fils)    AS captured_fils
          FROM refunds r
          JOIN transactions t ON t.id = r.transaction_id
         WHERE r.status = 'succeeded'
         GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain'), r.transaction_id
       ) per_sale
 GROUP BY per_sale.merchant_id, per_sale.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
