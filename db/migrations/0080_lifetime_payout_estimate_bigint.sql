-- merchants.lifetime_net_payout_monitoring_estimate was REAL (0040), bumped
-- with a float32. Above 2^24 fils (16,777.216 BD) neither can hold every fil,
-- so a high-volume merchant's total drifted and small payouts vanished. Make
-- it exact integer fils and recompute it from the paid batches it sums
-- (PayoutBatch is its only writer). Numbered past ADR-0005's 0054-0056.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = COALESCE(
         (SELECT SUM(net_payout_fils) FROM settlement_batches b
           WHERE b.merchant_id = m.id AND b.status = 'paid'), 0);
