-- After a load run: the checkout must have stayed correct under load.
-- Every row printed should read ok = t. :since = when the run started, so
-- leftovers from earlier runs (e.g. the pre-fix baseline) don't count.
WITH links AS (
  SELECT pl.* FROM payment_links pl WHERE pl.token LIKE 'plink_' || :'prefix' || '_%'
), load_tx AS (
  SELECT t.* FROM transactions t JOIN links l ON l.transaction_id = t.id
)
SELECT 'every paid link has exactly its captured transaction' AS invariant,
       count(*) FILTER (WHERE l.status = 'paid' AND (t.id IS NULL OR t.status <> 'captured' OR t.captured_fils <> l.amount_fils)) = 0 AS ok
  FROM links l LEFT JOIN transactions t ON t.id = l.transaction_id
UNION ALL
SELECT 'no link left reserved', count(*) FILTER (WHERE status = 'reserved') = 0 FROM links
UNION ALL
SELECT 'no captured sale behind an unpaid link', count(*) = 0
  FROM transactions t
 WHERE t.merchant_id = (SELECT id FROM merchants WHERE display_name = 'Load Test Merchant')
   AND t.status = 'captured' AND t.created_at >= :'since'::timestamptz
   AND NOT EXISTS (SELECT 1 FROM payment_links l WHERE l.transaction_id = t.id AND l.status = 'paid')
UNION ALL
SELECT 'no authorization left open (card held, no sale)', count(*) = 0
  FROM transactions t
 WHERE t.merchant_id = (SELECT id FROM merchants WHERE display_name = 'Load Test Merchant')
   AND t.status = 'authorized' AND t.created_at >= :'since'::timestamptz;
